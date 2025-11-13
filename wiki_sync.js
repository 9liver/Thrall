#!/usr/bin/env node

/**
 * BookStack to Wiki.js Sync Script
 * Production-ready with correct hierarchy and quiet operation
 * Usage: node wiki_sync.js [--dry-run] [--verbose]
 */

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs').promises;
const path = require('path');

const CONFIG_PATH = './config.json';
const STATE_PATH = './sync-state.json';

class Sync {
  constructor(config) {
    this.bookstack = config.bookstack;
    this.wikijs = config.wikijs;
    this.dryRun = config.dryRun || false;
    this.verbose = config.verbose || false;
    
    this.bookstackClient = axios.create({
      baseURL: `${this.bookstack.url}/api`,
      headers: {
        'Authorization': `Token ${this.bookstack.tokenId}:${this.bookstack.tokenSecret}`
      }
    });
    
    this.wikijsClient = axios.create({
      baseURL: `${this.wikijs.url}/graphql`,
      headers: {
        'Authorization': `Bearer ${this.wikijs.apiKey}`
      }
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
    await fs.mkdir(this.assetsDir, { recursive: true });
    
    this.log('=== Starting Sync ===', true);
    
    // Get user ID
    const userId = await this.getUserId();
    
    // Fetch all data
    const shelves = await this.fetchAll('/shelves');
    const books = await this.fetchAll('/books');
    const chapters = await this.fetchAll('/chapters');
    const pages = await this.fetchAll('/pages');
    
    this.log(`Hierarchy: ${shelves.length} shelves, ${books.length} books, ${chapters.length} chapters, ${pages.length} pages`, true);
    
    // Build shelf mapping
    const bookToShelf = await this.buildShelfMapping(shelves);
    
    // Process pages
    for (const page of pages) {
      try {
        // Get full page details
        const detail = await this.bookstackClient.get(`/pages/${page.id}`).then(r => r.data);
        
        // Build path
        const book = books.find(b => b.id === page.book_id);
        const shelf = bookToShelf.get(page.book_id);
        const chapter = chapters.find(c => c.id === page.chapter_id);
        
        const pathParts = [];
        if (shelf && shelf.slug) pathParts.push(shelf.slug);
        if (book && book.slug) pathParts.push(book.slug);
        if (chapter && chapter.slug) pathParts.push(chapter.slug);
        pathParts.push(page.slug);
        
        const pagePath = pathParts.join('/').toLowerCase().replace(/[^a-z0-9\/\-_]/g, '-');
        
        // Process content and assets
        const content = await this.processContent(detail.markdown || detail.html || '', detail.html || '');
        
        // Sync
        if (!this.dryRun) {
          await this.syncPage(pagePath, page.name, content, userId, !page.draft);
        }
        
        this.stats.pages++;
        this.log(`[PAGE] ${this.dryRun ? '[DRY] ' : ''}${pagePath}`);
        
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
      const { data } = await this.wikijsClient.post('', { query: '{ users { list { id email } } }' });
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
        const shelfBooks = await this.fetchAll(`/shelves/${shelf.id}/books`);
        for (const book of shelfBooks) {
          mapping.set(book.id, shelf);
        }
      } catch (error) {
        this.log(`[WARN] Failed to fetch books for shelf ${shelf.id}: ${error.message}`);
      }
    }
    return mapping;
  }

  async processContent(markdown, html) {
    let content = markdown || html || '';
    
    // Process images
    content = content.replace(/!\[([^\]]*)\]\(\/uploads\/images\/gallery\/[^\/]+\/([^)]+)\)/g, async (match, alt, filename) => {
      const imageKey = `img_${filename}`;
      if (!this.state.assets[imageKey]) {
        try {
          const url = `${this.bookstack.url}/uploads/images/gallery/2024-01/${filename}`;
          const response = await axios.get(url, { responseType: 'stream' });
          const filePath = `${this.assetsDir}/${filename}`;
          response.data.pipe(createWriteStream(filePath));
          await new Promise((resolve, reject) => response.data.on('end', resolve).on('error', reject));
          
          const uploadedPath = await this.uploadAsset(filePath, filename);
          this.state.assets[imageKey] = uploadedPath;
          this.stats.assets++;
          await fs.unlink(filePath);
          
          return `![${alt}](${uploadedPath})`;
        } catch (e) {
          this.log(`[WARN] Image ${filename}: ${e.message}`);
          return match;
        }
      }
      return `![${alt}](${this.state.assets[imageKey]})`;
    });

    // Process attachments asynchronously
    const attachmentMatches = content.match(/\[([^\]]+)\]\(\/attachments\/(\d+)\)/g);
    if (attachmentMatches) {
      for (const match of attachmentMatches) {
        const [, name, id] = match.match(/\[([^\]]+)\]\(\/attachments\/(\d+)\)/);
        const key = `att_${id}`;
        
        if (!this.state.assets[key]) {
          try {
            const response = await this.bookstackClient.get(`/attachments/${id}`, { responseType: 'stream' });
            const filename = response.headers['content-disposition']?.split('filename=')[1]?.replace(/"/g, '') || `attachment-${id}`;
            const filePath = `${this.assetsDir}/${filename}`;
            response.data.pipe(createWriteStream(filePath));
            await new Promise((resolve, reject) => response.data.on('end', resolve).on('error', reject));
            
            const uploadedPath = await this.uploadAsset(filePath, filename);
            this.state.assets[key] = uploadedPath;
            this.stats.assets++;
            await fs.unlink(filePath);
            
            content = content.replace(match, `[${name}](${uploadedPath})`);
          } catch (e) {
            this.log(`[WARN] Attachment ${id}: ${e.message}`);
          }
        } else {
          content = content.replace(match, `[${name}](${this.state.assets[key]})`);
        }
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
    const query = `{ pages { single(by: { path: "${path}" }) { id } } }`;
    const { data } = await this.wikijsClient.post('', { query });
    
    const pageData = {
      path,
      title,
      description: content,
      editor: 'markdown',
      isPublished: published,
      authorId: userId,
      creatorId: userId
    };

    if (data.data?.pages?.single) {
      const mutation = `mutation($id: Int!, $c: PageInput!) { pages { update(id: $id, content: $c) { responseResult { succeeded } } } }`;
      await this.wikijsClient.post('', {
        query: mutation,
        variables: { id: data.data.pages.single.id, c: pageData }
      });
    } else {
      const mutation = 'mutation($c: PageInput!) { pages { create(content: $c) { responseResult { succeeded } } } }';
      await this.wikijsClient.post('', {
        query: mutation,
        variables: { c: pageData }
      });
    }
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--init')) {
    const config = {
      bookstack: { url: 'http://localhost:6875', tokenId: '', tokenSecret: '' },
      wikijs: { url: 'http://localhost:3000', apiKey: '', defaultUserEmail: 'admin@example.com' },
      assetsDir: './sync-assets',
      dryRun: args.includes('--dry-run'),
      verbose: args.includes('--verbose')
    };
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log('Created config.json');
    return;
  }

  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  config.dryRun = args.includes('--dry-run');
  config.verbose = args.includes('--verbose');
  
  const sync = new Sync(config);
  await sync.run();
}

main().catch(console.error);
