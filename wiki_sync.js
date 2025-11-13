#!/usr/bin/env node

/**
 * BookStack to Wiki.js Sync Script
 * Ultra-robust version with automatic fallback
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
    skipUserMapping: true  // DEFAULT TO TRUE - avoids GraphQL user issues
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
    // Single hardcoded user ID for fallback - we'll fetch this once
    this.fallbackUserId = null;
  }

  async initialize() {
    console.log('[START] Initializing sync...');
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

    // Load or initialize state
    await this.loadState();
    
    // Ensure asset directory exists
    await fs.mkdir(this.config.sync.assetsDir, { recursive: true });
    
    // Get fallback user ID
    await this.resolveFallbackUser();
    
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
      // Try to get the first available user from Wiki.js
      const query = {
        query: `query { users { list { id email } } }`
      };
      
      const response = await this.wikijsClient.post('', query);
      
      if (response.data.errors) {
        console.warn('[USER] GraphQL error:', JSON.stringify(response.data.errors, null, 2));
        throw new Error('Cannot query users');
      }
      
      const users = response.data.data?.users?.list || [];
      
      if (users.length === 0) {
        throw new Error('No users found in Wiki.js');
      }
      
      // Prefer the configured default user email
      const defaultUser = users.find(u => u.email === this.config.wikijs.defaultUserEmail);
      this.fallbackUserId = defaultUser ? defaultUser.id : users[0].id;
      
      console.log(`[USER] Fallback user ID resolved: ${this.fallbackUserId}`);
      
    } catch (error) {
      console.warn(`[USER] Failed to resolve fallback user: ${error.message}`);
      console.warn('[USER] Will attempt to use default user ID: 1');
      this.fallbackUserId = 1; // Most common default admin ID
    }
  }

  async run() {
    try {
      await this.initialize();
      
      if (this.config.sync.dryRun) {
        console.log('[DRYRUN] Preview mode - no changes will be made');
      }

      console.log('[PROGRESS] Fetching BookStack hierarchy...');
      const hierarchy = await this.fetchBookStackHierarchy();
      console.log(`[SUCCESS] ${hierarchy.shelves.length} shelves, ${hierarchy.books.length} books, ${hierarchy.chapters.length} chapters, ${hierarchy.pages.length} pages`);

      // Skip user mapping by default
      if (!this.config.sync.skipUserMapping) {
        console.log('[PROGRESS] Mapping users...');
        await this.mapAllUsers(hierarchy.users);
      } else {
        console.log('[INFO] Skipping user mapping, using fallback user ID');
      }
      
      console.log('[PROGRESS] Syncing assets...');
      await this.syncAssets();

      console.log('[PROGRESS] Syncing pages...');
      await this.syncPages(hierarchy);

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
        
        const createdBy = this.extractUserId(data.created_by);
        const updatedBy = this.extractUserId(data.updated_by);
        
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
          shelf_id: page.shelf_id,
          chapter_id: page.chapter_id,
          created_by: createdBy,
          updated_by: updatedBy,
          bookSlug: hierarchy.books.find(b => b.id === page.book_id)?.slug || 'uncategorized',
          shelfSlug: hierarchy.shelves.find(s => s.id === page.shelf_id)?.slug,
          chapterSlug: hierarchy.chapters.find(c => c.id === page.chapter_id)?.slug
        });
        
        hierarchy.users.add(createdBy);
        hierarchy.users.add(updatedBy);
      } catch (error) {
        console.warn(`[WARN] Failed to enrich page ${page.id}: ${error.message}`);
      }
    }

    return hierarchy;
  }

  extractUserId(userField) {
    if (typeof userField === 'object' && userField !== null) {
      return userField.id || this.fallbackUserId;
    }
    return userField || this.fallbackUserId;
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
  // USER MAPPING (OPTIONAL)
  // =============================================================================

  async mapAllUsers(bookstackUserIds) {
    if (this.config.sync.skipUserMapping) {
      console.log('[USER] Mapping disabled - all content will use fallback user');
      return;
    }

    const uniqueIds = Array.from(bookstackUserIds).filter(id => id && typeof id === 'number');
    console.log(`[USER] Attempting to map ${uniqueIds.length} users...`);
    
    for (const userId of uniqueIds) {
      await this.mapUser(userId);
    }
  }

  async mapUser(bookstackUserId) {
    if (this.state.userMap[bookstackUserId]) return this.state.userMap[bookstackUserId];

    try {
      const userResponse = await this.bookstackClient.get(`/users/${bookstackUserId}`);
      const userEmail = userResponse.data.email || this.config.wikijs.defaultUserEmail;

      // In a real implementation, you'd query Wiki.js for this user
      // For now, just use fallback and log the mapping
      console.log(`[USER] Mapping BookStack user ${bookstackUserId} (${userEmail}) -> Wiki.js fallback user`);
      
      this.state.userMap[bookstackUserId] = this.fallbackUserId;
      return this.state.userMap[bookstackUserId];
    } catch (error) {
      console.warn(`[USER] Failed to get BookStack user ${bookstackUserId}:`, error.message);
      this.stats.userMappingErrors++;
      return this.fallbackUserId;
    }
  }

  // =============================================================================
  // ASSET SYNC
  // =============================================================================

  async syncAssets() {
    console.log('[ASSET] Starting asset synchronization...');
    
    // Sync images
    const images = await this.paginateBookStack('/image-gallery');
    console.log(`[ASSET] Found ${images.length} images`);
    for (const image of images) {
      await this.syncAsset('image', image);
    }

    // Sync attachments
    const attachments = await this.paginateBookStack('/attachments');
    console.log(`[ASSET] Found ${attachments.length} attachments`);
    for (const attachment of attachments) {
      await this.syncAsset('attachment', attachment);
    }
  }

  async syncAsset(type, asset) {
    const assetId = asset.id;
    const assetName = asset.name || path.basename(asset.path || `asset-${assetId}`);
    
    if (this.state.assetMap[assetId]) {
      console.log(`[ASSET] Skipping ${assetName} (already synced)`);
      return this.state.assetMap[assetId];
    }

    try {
      console.log(`[ASSET] Processing ${type}: ${assetName} (ID: ${assetId})`);
      
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
        console.log('[API] Uploading asset to Wiki.js...');
        wikijsPath = await this.uploadAssetToWikiJS(localPath, assetName);
      } else {
        console.log('[DRYRUN] Would upload asset to Wiki.js');
      }

      this.state.assetMap[assetId] = wikijsPath;
      this.stats.assetsUploaded++;
      await fs.unlink(localPath);

      console.log(`[ASSET] Success: ${wikijsPath}`);
      return wikijsPath;

    } catch (error) {
      console.error(`[ASSET] Failed ${assetName}: ${error.message}`);
      this.stats.errors++;
      return null;
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
    const sortedPages = hierarchy.pages.sort((a, b) => {
      const aDepth = this.getPagePath(a).split('/').length;
      const bDepth = this.getPagePath(b).split('/').length;
      return aDepth - bDepth;
    });

    console.log(`[PAGE] Processing ${sortedPages.length} pages...`);
    
    for (let i = 0; i < sortedPages.length; i++) {
      const page = sortedPages[i];
      console.log(`[PAGE] ${i + 1}/${sortedPages.length}: ${page.name}`);
      await this.syncPage(page, hierarchy);
    }
  }

  getPagePath(page) {
    const parts = [];
    
    if (page.shelfSlug) parts.push(page.shelfSlug);
    if (page.bookSlug) parts.push(page.bookSlug);
    if (page.chapterSlug) parts.push(page.chapterSlug);
    parts.push(page.slug);
    
    return parts
      .join(this.config.sync.hierarchySeparator)
      .toLowerCase()
      .replace(/[^a-z0-9\/\-_]/g, '-');
  }

  async syncPage(page, hierarchy) {
    const pagePath = this.getPagePath(page);
    
    try {
      const transformedMarkdown = await this.transformContent(page.markdown, page.html);
      const createdBy = this.config.sync.skipUserMapping ? this.fallbackUserId : await this.mapUser(page.created_by);
      const updatedBy = this.config.sync.skipUserMapping ? this.fallbackUserId : await this.mapUser(page.updated_by);

      const existingPage = await this.findWikiJSPage(pagePath);

      if (existingPage) {
        console.log(`[PAGE] Updating: ${pagePath}`);
        
        if (!this.config.sync.dryRun) {
          await this.updateWikiJSPage(existingPage.id, {
            title: page.name,
            description: transformedMarkdown,
            editor: 'markdown',
            isPublished: !page.draft,
            authorId: updatedBy
          });
        }
        this.stats.pagesUpdated++;
      } else {
        console.log(`[PAGE] Creating: ${pagePath}`);
        
        if (!this.config.sync.dryRun) {
          const newPage = await this.createWikiJSPage({
            path: pagePath,
            title: page.name,
            description: transformedMarkdown,
            editor: 'markdown',
            isPublished: !page.draft,
            authorId: createdBy,
            creatorId: createdBy
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
      console.warn('[WARN] Empty page content');
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
    const query = {
      query: `query { pages { single(by: { path: "${path}" }) { id path title } } }`
    };

    try {
      const response = await this.wikijsClient.post('', query);
      
      if (response.data.errors) {
        console.warn(`[WARN] GraphQL findPage error:`, JSON.stringify(response.data.errors));
        return null;
      }
      
      return response.data.data.pages.single;
    } catch (error) {
      if (error.response?.status === 404) return null;
      console.warn(`[WARN] findPage failed: ${error.message}`);
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
      throw new Error(`GraphQL error: ${JSON.stringify(response.data.errors)}`);
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
      throw new Error(`GraphQL error: ${JSON.stringify(response.data.errors)}`);
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
      console.log(`[STATE] Loaded (last sync: ${this.state.lastSync || 'never'})`);
    } catch (error) {
      console.log('[STATE] No previous state, starting fresh');
      this.state = {
        lastSync: null,
        pageMap: {},
        assetMap: {},
        userMap: {},
        defaultUserId: null
      };
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
    console.log(`User Mapping Errors: ${this.stats.userMappingErrors}`);
    console.log(`Total Errors: ${this.stats.errors}`);
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
      console.warn(`[CONFIG] Warning: ${error.message}`);
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
  if (args.includes('--skip-users')) {
    config.sync.skipUserMapping = true;
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
  pageSize: 100

wikijs:
  url: 'http://localhost:3000'
  apiKey: 'YOUR_WIKIJS_API_KEY'
  defaultUserEmail: 'admin@example.com'

sync:
  assetsDir: './sync-assets'
  hierarchySeparator: '/'
  includeDrafts: false
  dryRun: false
  skipUserMapping: true  # Set to false only if user mapping works
`;

  await fs.writeFile(CONFIG_PATH, template);
  console.log('[CONFIG] Template created: config.yaml');
  console.log('         Edit with your credentials, then run: node wiki_sync.js --dry-run');
}

if (require.main === module) {
  main().catch(error => {
    console.error('[FATAL] Unhandled:', error);
    process.exit(1);
  });
}

module.exports = BookStackToWikiJSSync;
