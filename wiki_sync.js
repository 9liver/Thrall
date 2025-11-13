#!/usr/bin/env node

/**
 * BookStack to Wiki.js Sync Script
 * Fixed version with proper shelf-book-page hierarchy
 * Usage: node wiki_sync.js [options]
 */

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const { createWriteStream } = require('fs');

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG_PATH = process.env.CONFIG_PATH || './config.yaml';
const STATE_PATH = process.env.STATE_PATH || './sync-state.json';

const DEFAULT_CONFIG = {
  bookstack: {
    url: 'http://localhost:6875',
    tokenId: '',
    tokenSecret: '',
    pageSize: 100
  },
  wikijs: {
    url: 'http://localhost:3000',
    apiKey: '',
    defaultUserEmail: 'admin@example.com'
  },
  sync: {
    assetsDir: './sync-assets',
    hierarchySeparator: '/',
    includeDrafts: false,
    dryRun: false,
    skipUserMapping: true  // DEFAULT: Skip user mapping
  }
};

// =============================================================================
// MAIN SYNC ORCHESTRATOR
// =============================================================================

class BookStackToWikiJSSync {
  constructor(config) {
    this.config = config;
    this.bookstackClient = null;
    this.wikijsClient = null;
    this.state = {
      lastSync: null,
      pageMap: {},
      assetMap: {},
      userMap: {},
      defaultUserId: null
    };
    this.stats = {
      pagesCreated: 0,
      pagesUpdated: 0,
      assetsUploaded: 0,
      userMappingErrors: 0,
      errors: 0
    };
    this.fallbackUserId = null;
    this.bookToShelfMap = new Map(); // bookId -> shelf object
    this.bookMap = new Map(); // bookId -> book object
  }

  async initialize() {
    console.log('[STARTUP] Initializing sync...');
    this.validateConfig();

    // Setup HTTP clients
    this.bookstackClient = axios.create({
      baseURL: `${this.config.bookstack.url}/api`,
      headers: {
        'Authorization': `Token ${this.config.bookstack.tokenId}:${this.config.bookstack.tokenSecret}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 30000,
      validateStatus: (status) => status < 500
    });

    this.wikijsClient = axios.create({
      baseURL: `${this.config.wikijs.url}/graphql`,
      headers: {
        'Authorization': `Bearer ${this.config.wikijs.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    // Load state
    await this.loadState();
    
    // Ensure asset directory exists
    await fs.mkdir(this.config.sync.assetsDir, { recursive: true });
    
    // Get fallback user ID
    await this.resolveFallbackUser();
    
    // Build book->shelf mapping
    await this.buildBookShelfMapping();
    
    console.log('[READY] Initialization complete');
  }

  validateConfig() {
    if (!this.config.bookstack.url || !this.config.bookstack.url.startsWith('http')) {
      throw new Error('[CONFIG] Invalid bookstack.url');
    }
    if (!this.config.wikijs.url || !this.config.wikijs.url.startsWith('http')) {
      throw new Error('[CONFIG] Invalid wikijs.url');
    }
    if (!this.config.bookstack.tokenId || !this.config.bookstack.tokenSecret) {
      throw new Error('[CONFIG] Missing BookStack API credentials');
    }
    if (!this.config.wikijs.apiKey) {
      throw new Error('[CONFIG] Missing Wiki.js API key');
    }
  }

  async resolveFallbackUser() {
    console.log('[USER] Resolving fallback user...');
    
    try {
      const query = { query: `{ users { list { id email } } }` };
      const response = await this.wikijsClient.post('', query);
      
      if (response.data.errors) {
        console.warn('[USER] GraphQL warning:', JSON.stringify(response.data.errors));
        throw new Error('User query failed');
      }
      
      const users = response.data.data?.users?.list || [];
      
      if (users.length === 0) {
        throw new Error('No users in Wiki.js');
      }
      
      const defaultUser = users.find(u => u.email === this.config.wikijs.defaultUserEmail);
      this.fallbackUserId = defaultUser ? defaultUser.id : users[0].id;
      
      console.log(`[USER] Fallback user ID: ${this.fallbackUserId}`);
      
    } catch (error) {
      console.warn(`[USER] Resolution failed: ${error.message}`);
      console.warn('[USER] Using ID: 1');
      this.fallbackUserId = 1;
    }
  }

  async buildBookShelfMapping() {
    console.log('[MAPPING] Building book->shelf relationships...');
    
    try {
      // Get all shelves
      const shelves = await this.paginateBookStack('/shelves');
      
      // For each shelf, get its books and build the mapping
      for (const shelf of shelves) {
        const shelfBooks = await this.paginateBookStack(`/shelves/${shelf.id}/books`);
        for (const book of shelfBooks) {
          this.bookToShelfMap.set(book.id, shelf);
          this.bookMap.set(book.id, book);
        }
      }
      
      console.log(`[MAPPING] Mapped ${this.bookToShelfMap.size} books to shelves`);
    } catch (error) {
      console.warn('[MAPPING] Failed:', error.message);
    }
  }

  async run() {
    try {
      await this.initialize();
      
      if (this.config.sync.dryRun) {
        console.log('[DRYRUN] Preview mode - no changes');
      }

      console.log('[PROGRESS] Fetching BookStack hierarchy...');
      const hierarchy = await this.fetchBookStackHierarchy();
      console.log(`[SUCCESS] ${hierarchy.shelves.length} shelves, ${hierarchy.books.length} books, ${hierarchy.chapters.length} chapters, ${hierarchy.pages.length} pages`);

      // Skip user mapping by default
      if (!this.config.sync.skipUserMapping) {
        console.log('[PROGRESS] Mapping users...');
        await this.mapAllUsers(hierarchy.users);
      } else {
        console.log('[INFO] User mapping disabled - using fallback user');
      }
      
      console.log('[PROGRESS] Syncing assets...');
      await this.syncAssets();

      console.log('[PROGRESS] Syncing pages...');
      await this.syncPages(hierarchy)

      console.log('[PROGRESS] Saving state...');
      await this.saveState();

      this.printStats();

    } catch (error) {
      console.error('[FATAL] Sync failed:', error.message);
      if (error.response) {
        console.error('[FATAL] Response:', {
          status: error.response.status,
          data: error.response.data
        });
      }
      process.exit(1);
    }
  }

  // =============================================================================
  // BOOKSTACK HIERARCHY FETCHING
  // =============================================================================

  async fetchBookStackHierarchy() {
    const hierarchy = {
      shelves: [],
      books: [],
      chapters: [],
      pages: [],
      users: new Set()
    };

    console.log('[API] Fetching shelves...');
    hierarchy.shelves = await this.paginateBookStack('/shelves');

    console.log('[API] Fetching books...');
    hierarchy.books = await this.paginateBookStack('/books');

    console.log('[API] Fetching chapters...');
    hierarchy.chapters = await this.paginateBookStack('/chapters');

    console.log('[API] Fetching pages...');
    const pages = await this.paginateBookStack('/pages');
    
    console.log('[API] Enriching page details...');
    for (const page of pages) {
      if (!this.config.sync.includeDrafts && page.draft) continue;

      try {
        const pageDetail = await this.bookstackClient.get(`/pages/${page.id}`);
        const data = pageDetail.data;
        
        // Get book and shelf information
        const book = this.bookMap.get(page.book_id) || hierarchy.books.find(b => b.id === page.book_id);
        const shelf = this.bookToShelfMap.get(page.book_id);
        
        hierarchy.pages.push({
          id: page.id,
          name: page.name,
          slug: page.slug,
          markdown: data.markdown || data.html || '',
          html: data.html || '',
          created_at: data.created_at,
          updated_at: data.updated_at,
          draft: page.draft,
          book_id: page.book_id,
          shelf_id: shelf?.id,
          chapter_id: page.chapter_id,
          created_by: this.fallbackUserId,
          updated_by: this.fallbackUserId,
          bookSlug: book?.slug || 'uncategorized',
          shelfSlug: shelf?.slug,
          chapterSlug: hierarchy.chapters.find(c => c.id === page.chapter_id)?.slug
        });
        
        hierarchy.users.add(this.fallbackUserId);
      } catch (error) {
        console.warn(`[WARN] Failed to enrich page ${page.id}: ${error.message}`);
      }
    }

    return hierarchy;
  }

  async paginateBookStack(endpoint) {
    const results = [];
    let page = 1;
    
    while (true) {
      try {
        const response = await this.bookstackClient.get(endpoint, {
          params: { page, count: this.config.bookstack.pageSize }
        });
        
        if (!response.data?.data) {
          console.warn(`[API] Unexpected response from ${endpoint}:`, response.data);
          break;
        }
        
        results.push(...response.data.data);
        
        if (response.data.data.length < this.config.bookstack.pageSize) {
          break;
        }
        page++;
      } catch (error) {
        console.error(`[API] Failed ${endpoint} page ${page}:`, error.message);
        break;
      }
    }
    
    return results;
  }

  // =============================================================================
  // USER MAPPING (NO-OP)
  // =============================================================================

  async mapAllUsers(bookstackUserIds) {
    // No-op - we always use fallback user
    console.log(`[USER] Processing ${bookstackUserIds.size} users (using fallback)`);
  }

  // =============================================================================
  // ASSET SYNC
  // =============================================================================

  async syncAssets() {
    console.log('[ASSET] Starting synchronization...');
    
    const images = await this.paginateBookStack('/image-gallery');
    console.log(`[ASSET] Images: ${images.length}`);
    for (const image of images) {
      await this.syncAsset('image', image);
    }

    const attachments = await this.paginateBookStack('/attachments');
    console.log(`[ASSET] Attachments: ${attachments.length}`);
    for (const attachment of attachments) {
      await this.syncAsset('attachment', attachment);
    }
  }

  async syncAsset(type, asset) {
    const assetId = asset.id;
    const assetName = asset.name || path.basename(asset.path || `asset-${assetId}`);
    
    if (this.state.assetMap[assetId]) {
      console.log(`[ASSET] Skip ${assetName} (synced)`);
      return this.state.assetMap[assetId];
    }

    try {
      console.log(`[ASSET] Process ${type}: ${assetName}`);
      
      const downloadUrl = type === 'image' 
        ? `${this.config.bookstack.url}${asset.path}`
        : `${this.config.bookstack.url}/attachments/${assetId}`;
      
      const response = await this.bookstackClient.get(downloadUrl, {
        responseType: 'stream'
      });

      const localPath = path.join(this.config.sync.assetsDir, `${assetId}-${assetName}`);
      const writer = createWriteStream(localPath);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      let wikijsPath = '/assets/default.png';
      
      if (!this.config.sync.dryRun) {
        console.log('[API] Uploading...');
        wikijsPath = await this.uploadAssetToWikiJS(localPath, assetName);
      } else {
        console.log('[DRYRUN] Would upload');
      }

      this.state.assetMap[assetId] = wikijsPath;
      this.stats.assetsUploaded++;
      await fs.unlink(localPath);

      console.log(`[ASSET] Success: ${wikijsPath}`);

    } catch (error) {
      console.error(`[ASSET] Failed ${assetName}: ${error.message}`);
      this.stats.errors++;
    }
  }

  async uploadAssetToWikiJS(filePath, originalName) {
    const fileBuffer = await fs.readFile(filePath);
    const form = new FormData();
    form.append('media', fileBuffer, {
      filename: originalName,
      contentType: 'application/octet-stream'
    });

    const uploadEndpoint = `${this.config.wikijs.url}/u`;
    const response = await axios.post(uploadEndpoint, form, {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${this.config.wikijs.apiKey}`
      },
      timeout: 60000
    });

    if (response.data.error) {
      throw new Error(`Upload failed: ${response.data.error}`);
    }

    return response.data;
  }

  // =============================================================================
  // PAGE SYNC
  // =============================================================================

  async syncPages(hierarchy) {
    // Sort by path depth to ensure parent pages are created first
    const sortedPages = hierarchy.pages.sort((a, b) => {
      const aDepth = this.getPagePath(a).split('/').length;
      const bDepth = this.getPagePath(b).split('/').length;
      return aDepth - bDepth;
    });

    console.log(`[PAGE] Processing ${sortedPages.length} pages...`);
    
    for (let i = 0; i < sortedPages.length; i++) {
      const page = sortedPages[i];
      console.log(`[PAGE] ${i + 1}/${sortedPages.length}: ${page.name}`);
      await this.syncPage(page);
    }
  }

  getPagePath(page) {
    const parts = [];
    
    // Add shelf slug if available
    if (page.shelfSlug) {
      parts.push(page.shelfSlug);
    }
    
    // Add book slug
    if (page.bookSlug) {
      parts.push(page.bookSlug);
    }
    
    // Add chapter slug if available
    if (page.chapterSlug) {
      parts.push(page.chapterSlug);
    }
    
    // Always add page slug last
    parts.push(page.slug);
    
    // Clean up the path
    const finalPath = parts
      .join(this.config.sync.hierarchySeparator)
      .toLowerCase()
      .replace(/[^a-z0-9\/\-_]/g, '-');
    
    // Log the path construction for debugging
    console.log(`[DEBUG] Path construction: ${parts.join(' -> ')} => ${finalPath}`);
    
    return finalPath;
  }

  async syncPage(page) {
    const pagePath = this.getPagePath(page);
    
    try {
      const transformedMarkdown = await this.transformContent(page.markdown, page.html);
      const userId = this.fallbackUserId; // Always use fallback

      const existingPage = await this.findWikiJSPage(pagePath);

      if (existingPage) {
        console.log(`[PAGE] Update: ${pagePath}`);
        
        if (!this.config.sync.dryRun) {
          await this.updateWikiJSPage(existingPage.id, {
            title: page.name,
            description: transformedMarkdown,
            editor: 'markdown',
            isPublished: !page.draft,
            authorId: userId
          });
        }
        this.stats.pagesUpdated++;
      } else {
        console.log(`[PAGE] Create: ${pagePath}`);
        
        if (!this.config.sync.dryRun) {
          const newPage = await this.createWikiJSPage({
            path: pagePath,
            title: page.name,
            description: transformedMarkdown,
            editor: 'markdown',
            isPublished: !page.draft,
            authorId: userId,
            creatorId: userId
          });
          
          this.state.pageMap[page.id] = newPage.id;
        } else {
          console.log('[DRYRUN] Would create page');
        }
        this.stats.pagesCreated++;
      }
    } catch (error) {
      console.error(`[PAGE] Failed ${page.name}: ${error.message}`);
      this.stats.errors++;
    }
  }

  async transformContent(markdown, html) {
    let content = markdown || html || '';
    
    if (!content) {
      console.warn('[WARN] Empty content');
      return ' ';
    }

    // Replace image references
    content = content.replace(/!\[([^\]]*)\]\(\/uploads\/images\/gallery\/[^\/]+\/([^)]+)\)/g, (match, alt, filename) => {
      const imageEntry = Object.entries(this.state.assetMap).find(([id, assetPath]) => 
        assetPath && (assetPath.includes(filename) || assetPath.includes(encodeURIComponent(filename)))
      );
      
      if (imageEntry) {
        const [, wikijsPath] = imageEntry;
        return `![${alt}](${wikijsPath})`;
      }
      
      console.warn(`[WARN] Image mapping missing: ${filename}`);
      return match;
    });

    // Replace attachment links
    content = content.replace(/\[([^\]]+)\]\(\/attachments\/(\d+)\)/g, (match, name, attachmentId) => {
      const wikijsPath = this.state.assetMap[attachmentId];
      if (wikijsPath) {
        return `[${name}](${wikijsPath})`;
      }
      console.warn(`[WARN] Attachment mapping missing: ID ${attachmentId}`);
      return match;
    });

    return content;
  }

  async findWikiJSPage(path) {
    // Use inline query to avoid variable issues
    const query = {
      query: `{ pages { single(by: { path: "${path}" }) { id path title } } }`
    };

    try {
      const response = await this.wikijsClient.post('', query);
      
      if (response.data.errors) {
        // Likely "not found" - not an error
        return null;
      }
      
      return response.data.data.pages.single;
    } catch (error) {
      if (error.response?.status === 404 || error.response?.status === 400) {
        return null;
      }
      console.warn(`[WARN] findPage: ${error.message}`);
      return null;
    }
  }

  async createWikiJSPage(pageData) {
    const mutation = {
      query: `mutation($content: PageInput!) { 
        pages { 
          create(content: $content) { 
            responseResult { succeeded errorCode message } 
            page { id path } 
          } 
        } 
      }`,
      variables: {
        content: {
          path: pageData.path,
          title: pageData.title,
          description: pageData.description,
          editor: 'markdown',
          isPublished: pageData.isPublished,
          authorId: pageData.authorId,
          creatorId: pageData.creatorId
        }
      }
    };

    const response = await this.wikijsClient.post('', mutation);
    
    if (response.data.errors) {
      throw new Error(`GraphQL: ${JSON.stringify(response.data.errors)}`);
    }
    
    const result = response.data.data.pages.create;
    
    if (!result.responseResult.succeeded) {
      throw new Error(`Create failed: ${result.responseResult.message}`);
    }
    
    return result.page;
  }

  async updateWikiJSPage(pageId, pageData) {
    const mutation = {
      query: `mutation($id: Int!, $content: PageInput!) { 
        pages { 
          update(id: $id, content: $content) { 
            responseResult { succeeded errorCode message } 
          } 
        } 
      }`,
      variables: {
        id: pageId,
        content: {
          title: pageData.title,
          description: pageData.description,
          editor: 'markdown',
          isPublished: pageData.isPublished,
          authorId: pageData.authorId
        }
      }
    };

    const response = await this.wikijsClient.post('', mutation);
    
    if (response.data.errors) {
      throw new Error(`GraphQL: ${JSON.stringify(response.data.errors)}`);
    }
    
    const result = response.data.data.pages.update;
    
    if (!result.responseResult.succeeded) {
      throw new Error(`Update failed: ${result.responseResult.message}`);
    }
  }

  // =============================================================================
  // STATE MANAGEMENT
  // =============================================================================

  async loadState() {
    try {
      const data = await fs.readFile(STATE_PATH, 'utf8');
      this.state = JSON.parse(data);
      console.log(`[STATE] Loaded (last: ${this.state.lastSync || 'never'})`);
    } catch (error) {
      console.log('[STATE] Fresh start');
    }
  }

  async saveState() {
    this.state.lastSync = new Date().toISOString();
    await fs.writeFile(STATE_PATH, JSON.stringify(this.state, null, 2));
    console.log('[STATE] Saved');
  }

  printStats() {
    console.log('\n' + '='.repeat(50));
    console.log('SYNC STATISTICS');
    console.log('='.repeat(50));
    console.log(`Pages Created: ${this.stats.pagesCreated}`);
    console.log(`Pages Updated: ${this.stats.pagesUpdated}`);
    console.log(`Assets Uploaded: ${this.stats.assetsUploaded}`);
    console.log(`Errors: ${this.stats.errors}`);
    console.log('='.repeat(50));
  }
}

// =============================================================================
// CLI & EXECUTION
// =============================================================================

async function main() {
  let config = DEFAULT_CONFIG;
  
  try {
    const configFile = await fs.readFile(CONFIG_PATH, 'utf8');
    const userConfig = yaml.load(configFile);
    config = { ...config, ...userConfig };
    config.bookstack = { ...config.bookstack, ...(userConfig.bookstack || {}) };
    config.wikijs = { ...config.wikijs, ...(userConfig.wikijs || {}) };
    config.sync = { ...config.sync, ...(userConfig.sync || {}) };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[CONFIG] ${error.message}`);
    }
    console.log('[CONFIG] Using defaults, create config.yaml with --init');
  }

  const args = process.argv.slice(2);
  if (args.includes('--init')) {
    await createTemplateConfig();
    return;
  }
  if (args.includes('--dry-run')) {
    config.sync.dryRun = true;
  }

  try {
    const sync = new BookStackToWikiJSSync(config);
    await sync.run();
  } catch (error) {
    console.error('[FATAL] Terminated:', error.message);
    process.exit(1);
  }
}

async function createTemplateConfig() {
  const template = `# BookStack to Wiki.js Sync Configuration

bookstack:
  url: 'http://localhost:6875'
  tokenId: 'YOUR_BOOKSTACK_TOKEN_ID'
  tokenSecret: 'YOUR_BOOKSTACK_SECRET'

wikijs:
  url: 'http://localhost:3000'
  apiKey: 'YOUR_WIKIJS_API_KEY'
  defaultUserEmail: 'admin@example.com'

sync:
  assetsDir: './sync-assets'
  hierarchySeparator: '/'
  includeDrafts: false
  dryRun: false
  skipUserMapping: true  # Keep true to avoid GraphQL issues
`;

  await fs.writeFile(CONFIG_PATH, template);
  console.log('[CONFIG] Template created: config.yaml');
  console.log('         Edit with your credentials');
}

if (require.main === module) {
  main().catch(error => {
    console.error('[FATAL] Unhandled:', error);
    process.exit(1);
  });
}

module.exports = BookStackToWikiJSSync;
