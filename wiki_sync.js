#!/usr/bin/env node

// BookStack to Wiki.js Sync - Production Version

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs').promises;
const path = require('path');

const CONFIG_PATH = './config.json';
const STATE_PATH = './sync-state.json';

class Sync {
  constructor(config) {
    // Support both old and new config structures
    this.bookstack = config.bookstack || config;
    this.wikijs = config.wikijs || {};
    this.dryRun = config.dryRun || false;
    this.verbose = config.verbose || false;
    
    this.bookstackClient = axios.create({
      baseURL: `${this.bookstack.url}/api`,
      headers: {
        'Authorization': `Token ${this.bookstack.tokenId}:${this.bookstack.tokenSecret}`
      },
      timeout: 30000
    });
    
    this.wikijsClient = axios.create({
      baseURL: `${this.wikijs.url}/graphql`,
      headers: {
        'Authorization': `Bearer ${this.wikijs.apiKey}`
      },
      timeout: 30000
    });
    
    this.state = { assets: {}, pages: {} };
    this.stats = { pages: 0, assets: 0, errors: 0 };
  }

  log(message, force = false) {
    if (this.verbose || force) {
      console.log(message);
    }
  }

  async loadState() {
    try {
      this.state = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
    } catch {
      this.state = { assets: {}, pages: {} };
    }
  }

  async saveState() {
    await fs.writeFile(STATE_PATH, JSON.stringify(this.state, null, 2));
  }

  async run() {
    await this.loadState();
    await fs.mkdir(ASSETS_DIR, { recursive: true });
    
    this.log('=== Starting Sync ===', true);
    
    const userId = await this.getUserId();
    const shelves = await this.fetchAll('/shelves');
    const books = await this.fetchAll('/books');
    const chapters = await this.fetchAll('/chapters');
    const pages = await this.fetchAll('/pages');
    
    this.log(`Found: ${shelves.length} shelves, ${books.length} books, ${chapters.length} chapters, ${pages.length} pages`, true);
    
    // Build shelf mapping
    const bookToShelf = await this.buildShelfMapping(shelves);
    this.log(`[DEBUG] ${bookToShelf.size} books mapped to shelves`, this.verbose);
    
    // Process pages
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      try {
        const detail = await this.bookstackClient.get(`/pages/${page.id}`).then(r => r.data);
        
        // Build full path with correct hierarchy
        const book = books.find(b => b.id === page.book_id);
        const shelf = bookToShelf.get(page.book_id);
        const chapter = chapters.find(c => c.id === page.chapter_id);
        
        const pathParts = [];
        if (shelf?.slug) {
          pathParts.push(shelf.slug);
          this.log(`[DEBUG] Added shelf slug: ${shelf.slug}`, this.verbose);
        }
        if (book?.slug) {
          pathParts.push(book.slug);
          this.log(`[DEBUG] Added book slug: ${book.slug}`, this.verbose);
        }
        if (chapter?.slug) {
          pathParts.push(chapter.slug);
          this.log(`[DEBUG] Added chapter slug: ${chapter.slug}`, this.verbose);
        }
        pathParts.push(page.slug);
        
        const pagePath = pathParts.join('/').toLowerCase().replace(/[^a-z0-9\/\-_]/g, '-');
        this.log(`[DEBUG] Final path: ${pagePath}`, this.verbose);
        
        // Process content
        const content = await this.processContent(detail.markdown || detail.html || '', pagePath);
        
        // Sync
        if (!this.dryRun) {
          await this.syncPage(pagePath, page.name, content, userId, !page.draft);
        }
        
        this.stats.pages++;
        console.log(`${this.dryRun ? '[DRY] ' : ''}[PAGE] ${pagePath}`);
        
      } catch (error) {
        this.stats.errors++;
        console.error(`[ERROR] Page ${page.id}: ${error.message}`);
      }
    }
    
    await this.saveState();
    this.log('\n=== Sync Complete ===', true);
    console.log(`Pages: ${this.stats.pages}, Assets: ${this.stats.assets}, Errors: ${this.stats.errors}`);
  }

  async fetchAll(endpoint) {
    const results = [];
    let page = 1;
    while (true) {
      const { data } = await this.bookstackClient.get(endpoint, { params: { page, count: 100 } });
      if (!data?.data?.length) break;
      results.push(...data.data);
      if (data.data.length < 100) break;
      page++;
    }
    return results;
  }

  async getUserId() {
    try {
      const { data } = await this.wikijsClient.post('', { 
        query: '{ users { list { id email } } }' 
      });
      const users = data.data?.users?.list || [];
      const defaultUser = users.find(u => u.email === this.wikijs.defaultUserEmail);
      return defaultUser?.id || users[0]?.id || 1;
    } catch {
      return 1;
    }
  }

  async buildShelfMapping(shelves) {
    const mapping = new Map();
    for (const shelf of shelves) {
      try {
        this.log(`[DEBUG] Querying shelf ${shelf.id} (${shelf.name}) for books...`, this.verbose);
        const shelfBooks = await this.fetchAll(`/shelves/${shelf.id}/books`);
        this.log(`[DEBUG] Shelf ${shelf.id} has ${shelfBooks.length} books`, this.verbose);
        for (const book of shelfBooks) {
          mapping.set(book.id, shelf);
        }
      } catch (error) {
        this.log(`[WARN] Shelf ${shelf.id}: ${error.message}`, this.verbose);
      }
    }
    return mapping;
  }

  async processContent(content, pagePath) {
    // Process images
    const imageRegex = /!\[([^\]]*)\]\(\/uploads\/images\/gallery\/[^\/]+\/([^)]+)\)/g;
    const imageMatches = [...content.matchAll(imageRegex)];
    for (const match of imageMatches) {
      const [, alt, filename] = match;
      const key = `img_${filename}`;
      
      if (!this.state.assets[key]) {
        try {
          const imageUrl = `${this.bookstack.url}/uploads/images/gallery/2024-01/${filename}`;
          const response = await axios.get(imageUrl, { responseType: 'stream' });
          const filePath = path.join(ASSETS_DIR, filename);
          response.data.pipe(createWriteStream(filePath));
          await new Promise((resolve, reject) => response.data.on('end', resolve).on('error', reject));
          
          const uploadedPath = await this.uploadAsset(filePath, filename);
          this.state.assets[key] = uploadedPath;
          this.stats.assets++;
          await fs.unlink(filePath);
          
          content = content.replace(match[0], `![${alt}](${uploadedPath})`);
        } catch (e) {
          this.log(`[WARN] Image ${filename}: ${e.message}`);
        }
      } else {
        content = content.replace(match[0], `![${alt}](${this.state.assets[key]})`);
      }
    }

    // Process attachments
    const attachmentRegex = /\[([^\]]+)\]\(\/attachments\/(\d+)\)/g;
    const attachmentMatches = [...content.matchAll(attachmentRegex)];
    for (const match of attachmentMatches) {
      const [, name, id] = match;
      const key = `att_${id}`;
      
      if (!this.state.assets[key]) {
        try {
          const response = await this.bookstackClient.get(`/attachments/${id}`, { responseType: 'stream' });
          const filename = response.headers['content-disposition']?.split('filename=')[1]?.replace(/"/g, '') || `attachment-${id}`;
          const filePath = path.join(ASSETS_DIR, filename);
          response.data.pipe(createWriteStream(filePath));
          await new Promise((resolve, reject) => response.data.on('end', resolve).on('error', reject));
          
          const uploadedPath = await this.uploadAsset(filePath, filename);
          this.state.assets[key] = uploadedPath;
          this.stats.assets++;
          await fs.unlink(filePath);
          
          content = content.replace(match[0], `[${name}](${uploadedPath})`);
        } catch (e) {
          this.log(`[WARN] Attachment ${id}: ${e.message}`);
        }
      } else {
        content = content.replace(match[0], `[${name}](${this.state.assets[key]})`);
      }
    }

    return content;
  }

  async uploadAsset(filePath, filename) {
    const buffer = await fs.readFile(filePath);
    const form = new FormData();
    form.append('media', buffer, { filename });
    
    const { data } = await axios.post(`${this.wikijs.url}/u`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${this.wikijs.apiKey}` }
    });
    
    return data;
  }

  async syncPage(path, title, content, userId, published) {
    const checkQuery = `{ pages { single(by: { path: "${path}" }) { id } } }`;
    const { data } = await this.wikijsClient.post('', { query: checkQuery });
    
    const pageData = { path, title, description: content, editor: 'markdown', isPublished: published, authorId: userId, creatorId: userId };

    if (data.data?.pages?.single) {
      const mutation = `mutation($id: Int!, $c: PageInput!) { pages { update(id: $id, content: $c) { responseResult { succeeded } } } }`;
      await this.wikijsClient.post('', { query: mutation, variables: { id: data.data.pages.single.id, c: pageData } });
    } else {
      const mutation = 'mutation($c: PageInput!) { pages { create(content: $c) { responseResult { succeeded } } } }';
      await this.wikijsClient.post('', { query: mutation, variables: { c: pageData } });
    }
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--init')) {
    const config = {
      bookstack: { url: 'http://localhost:6875', tokenId: '', tokenSecret: '' },
      wikijs: { url: 'http://localhost:3000', apiKey: '', defaultUserEmail: 'admin@example.com' }
    };
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log('[CONFIG] Created config.json. Edit with your credentials.');
    return;
  }

  if (!(await fs.access(CONFIG_PATH).then(() => true).catch(() => false))) {
    console.error('[ERROR] config.json not found. Run: node wiki_sync.js --init');
    process.exit(1);
  }

  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  config.dryRun = args.includes('--dry-run');
  config.verbose = args.includes('--verbose');
  
  const sync = new Sync(config);
  await sync.run();
}

main().catch(console.error);
