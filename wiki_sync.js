#!/usr/bin/env node

// BookStack to Wiki.js Sync - Production Ready

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs').promises;
const path = require('path');

const CONFIG_PATH = './config.json';
const STATE_PATH = './sync-state.json';
const ASSETS_DIR = './sync-assets';

class Sync {
  constructor(config) {
    this.config = config;
    this.dryRun = config.dryRun || false;
    
    this.bookstackClient = axios.create({
      baseURL: `${config.bookstack.url}/api`,
      headers: {
        'Authorization': `Token ${config.bookstack.tokenId}:${config.bookstack.tokenSecret}`
      }
    });
    
    this.wikijsClient = axios.create({
      baseURL: `${config.wikijs.url}/graphql`,
      headers: {
        'Authorization': `Bearer ${config.wikijs.apiKey}`
      }
    });
    
    this.state = { assets: {}, pages: {} };
    this.stats = { pages: 0, assets: 0, errors: 0 };
  }

  async run() {
    await this.loadState();
    await fs.mkdir(ASSETS_DIR, { recursive: true });
    
    console.log('=== Sync Started ===');
    
    const userId = await this.getUserId();
    const shelves = await this.fetchAll('/shelves');
    const books = await this.fetchAll('/books');
    const chapters = await this.fetchAll('/chapters');
    const pages = await this.fetchAll('/pages');
    
    console.log(`Loaded: ${shelves.length} shelves, ${books.length} books, ${chapters.length} chapters, ${pages.length} pages`);
    
    // Build shelf mapping
    const shelfMap = await this.buildShelfMapping(shelves);
    
    // Process pages
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      try {
        const detail = await this.bookstackClient.get(`/pages/${page.id}`).then(r => r.data);
        
        // Build path with shelf
        const book = books.find(b => b.id === page.book_id);
        const shelf = shelfMap.get(page.book_id);
        const chapter = chapters.find(c => c.id === page.chapter_id);
        
        const pathParts = [];
        if (shelf?.slug) pathParts.push(shelf.slug);
        if (book?.slug) pathParts.push(book.slug);
        if (chapter?.slug) pathParts.push(chapter.slug);
        pathParts.push(page.slug);
        
        const pagePath = pathParts.join('/').toLowerCase().replace(/[^a-z0-9\/\-_]/g, '-');
        
        console.log(`[${i + 1}/${pages.length}] ${pagePath}`);
        
        // Process assets
        const content = await this.processContent(detail.markdown || detail.html || '', pagePath);
        
        // Sync page
        if (!this.dryRun) {
          await this.syncPage(pagePath, page.name, content, userId, !page.draft);
        }
        
        this.stats.pages++;
        
      } catch (error) {
        this.stats.errors++;
        console.error(`[ERROR] Page ${page.id}: ${error.message}`);
      }
    }
    
    await this.saveState();
    console.log('\n=== Sync Complete ===');
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
      return users[0]?.id || 1;
    } catch {
      return 1;
    }
  }

  async buildShelfMapping(shelves) {
    const map = new Map();
    for (const shelf of shelves) {
      try {
        const shelfBooks = await this.fetchAll(`/shelves/${shelf.id}/books`);
        for (const book of shelfBooks) {
          map.set(book.id, shelf);
        }
      } catch (error) {
        console.warn(`Shelf ${shelf.id}: ${error.message}`);
      }
    }
    return map;
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
          const imageUrl = `${this.config.bookstack.url}/uploads/images/gallery/2024-01/${filename}`;
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
          console.warn(`Image failed: ${filename}`);
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
          console.warn(`Attachment failed: ${id}`);
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
    
    const { data } = await axios.post(`${this.config.wikijs.url}/u`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${this.config.wikijs.apiKey}` }
    });
    
    return data;
  }

  async syncPage(path, title, content, userId, published) {
    const query = `{ pages { single(by: { path: "${path}" }) { id } } }`;
    const { data } = await this.wikijsClient.post('', { query });
    
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
      wikijs: { url: 'http://localhost:3000', apiKey: '', defaultUserEmail: 'admin@example.com' },
      dryRun: false
    };
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log('Created config.json - edit with your credentials');
    return;
  }

  if (!(await fs.access(CONFIG_PATH).then(() => true).catch(() => false))) {
    console.error('ERROR: config.json not found. Run: node wiki_sync.js --init');
    process.exit(1);
  }

  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  config.dryRun = args.includes('--dry-run');
  
  const sync = new Sync(config);
  await sync.run();
}

main().catch(console.error);
