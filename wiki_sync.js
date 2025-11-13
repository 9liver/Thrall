#!/usr/bin/env node

/**
 * BookStack to Wiki.js Sync Script
 * API-based sync with full hierarchy, attachments, and user mapping
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
    skipUserMapping: false,
    batchSize: 5
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
    this.wikiJSUsers = null; // Cache for all Wiki.js users
  }

  async initialize() {
    console.log('[STARTUP] Initializing BookStack -> Wiki.js Sync...');
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

    // Load sync state
    await this.loadState();
    
    // Ensure asset directory exists
    await fs.mkdir(this.config.sync.assetsDir, { recursive: true });
    
    console.log('[STARTUP] Initialization complete');
  }

  validateConfig() {
    if (!this.config.bookstack.url || !this.config.bookstack.url.startsWith('http')) {
      throw new Error('Invalid bookstack.url in configuration');
    }
    if (!this.config.wikijs.url || !this.config.wikijs.url.startsWith('http')) {
      throw new Error('Invalid wikijs.url in configuration');
    }
    if (!this.config.bookstack.tokenId || !this.config.bookstack.tokenSecret) {
      throw new Error('BookStack API credentials not configured');
    }
    if (!this.config.wikijs.apiKey) {
      throw new Error('Wiki.js API key not configured');
    }
  }

  async run() {
    try {
      await this.initialize();
      
      if (this.config.sync.dryRun) {
        console.log('[DRYRUN] Preview mode - no changes will be made');
      }

      console.log('[PROGRESS] Fetching BookStack content hierarchy...');
      const hierarchy = await this.fetchBookStackHierarchy();
      console.log(`[SUCCESS] Found ${hierarchy.shelves.length} shelves, ${hierarchy.books.length} books, ${hierarchy.chapters.length} chapters, ${hierarchy.pages.length} pages`);

      // Preload Wiki.js users for mapping
      if (!this.config.sync.skipUserMapping) {
        console.log('[PROGRESS] Loading Wiki.js users for mapping...');
        await this.loadWikiJSUsers();
        console.log(`[SUCCESS] Loaded ${this.wikiJSUsers.length} Wiki.js users`);
      }

      console.log('[PROGRESS] Mapping BookStack users...');
      await this.mapAllUsers(hierarchy.users);
      
      console.log('[PROGRESS] Processing assets...');
      await this.syncAssets();

      console.log('[PROGRESS] Syncing pages...');
      await this.syncPages(hierarchy);

      console.log('[PROGRESS] Saving sync state...');
      await this.saveState();

      this.printStats();

    } catch (error) {
      console.error('[FATAL] Sync failed:', error.message);
      if (error.response) {
        console.error('[FATAL] API Response:', {
          status: error.response.status,
          data: JSON.stringify(error.response.data, null, 2)
        });
      }
      this.stats.errors++;
      throw error;
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

    console.log('[API] Fetching shelves from BookStack...');
    const shelves = await this.paginateBookStack('/shelves');
    hierarchy.shelves = shelves;

    console.log('[API] Fetching books from BookStack...');
    const books = await this.paginateBookStack('/books');
    hierarchy.books = books;

    console.log('[API] Fetching chapters from BookStack...');
    const chapters = await this.paginateBookStack('/chapters');
    hierarchy.chapters = chapters;

    console.log('[API] Fetching pages from BookStack...');
    const pages = await this.paginateBookStack('/pages');
    
    console.log('[API] Enriching page data...');
    for (const page of pages) {
      if (!this.config.sync.includeDrafts && page.draft) {
        continue;
      }

      try {
        const pageResponse = await this.bookstackClient.get(`/pages/${page.id}`);
        const pageDetail = pageResponse.data;
        
        const createdBy = this.extractUserId(pageDetail.created_by);
        const updatedBy = this.extractUserId(pageDetail.updated_by);
        
        const enrichedPage = {
          id: page.id,
          name: page.name,
          slug: page.slug,
          markdown: pageDetail.markdown || pageDetail.html || '',
          html: pageDetail.html || '',
          created_at: page.created_at,
          updated_at: page.updated_at,
          draft: page.draft,
          book_id: page.book_id,
          shelf_id: page.shelf_id,
          chapter_id: page.chapter_id,
          created_by: createdBy,
          updated_by: updatedBy,
          bookSlug: books.find(b => b.id === page.book_id)?.slug || 'uncategorized',
          shelfSlug: shelves.find(s => s.id === page.shelf_id)?.slug,
          chapterSlug: chapters.find(c => c.id === page.chapter_id)?.slug
        };
        
        hierarchy.pages.push(enrichedPage);
        hierarchy.users.add(createdBy);
        hierarchy.users.add(updatedBy);
      } catch (error) {
        console.error(`[WARN] Failed to enrich page ${page.id}:`, error.message);
      }
    }

    return hierarchy;
  }

  extractUserId(userField) {
    if (typeof userField === 'object' && userField !== null) {
      return userField.id || this.config.wikijs.defaultUserEmail;
    }
    return userField || this.config.wikijs.defaultUserEmail;
  }

  async paginateBookStack(endpoint) {
    const results = [];
    let page = 1;
    
    while (true) {
      try {
        const response = await this.bookstackClient.get(endpoint, {
          params: { page, count: this.config.bookstack.pageSize }
        });
        
        if (!response.data || !response.data.data) {
          console.warn(`[WARN] Unexpected response from ${endpoint}:`, JSON.stringify(response.data));
          break;
        }
        
        results.push(...response.data.data);
        
        if (response.data.data.length < this.config.bookstack.pageSize) {
          break;
        }
        page++;
      } catch (error) {
        console.error(`[ERROR] Failed to fetch ${endpoint} page ${page}:`, error.message);
        break;
      }
    }
    
    return results;
  }

  // =============================================================================
  // WIKI.JS USER LOADING
  // =============================================================================

  async loadWikiJSUsers() {
    try {
      // Query all users from Wiki.js
      const query = {
        query: `
          {
            users {
              list {
                id
                email
                name
              }
            }
          }
        `
      };

      const response = await this.wikijsClient.post('', query);
      
      if (response.data.errors) {
        console.error('[ERROR] GraphQL errors loading users:', JSON.stringify(response.data.errors, null, 2));
        throw new Error('Failed to load Wiki.js users');
      }
      
      this.wikiJSUsers = response.data.data.users.list || [];
      
    } catch (error) {
      console.error('[ERROR] Failed to load Wiki.js users:', error.message);
      // Continue with empty user list - will use default user for everything
      this.wikiJSUsers = [];
    }
  }

  getWikiJSUserByEmail(email) {
    return this.wikiJSUsers.find(u => u.email === email);
  }

  async getDefaultUserId() {
    if (this.state.defaultUserId) {
      return this.state.defaultUserId;
    }

    const defaultUser = this.getWikiJSUserByEmail(this.config.wikijs.defaultUserEmail);
    
    if (!defaultUser) {
      throw new Error(`Default user ${this.config.wikijs.defaultUserEmail} not found in Wiki.js`);
    }
    
    this.state.defaultUserId = defaultUser.id;
    console.log(`[INFO] Default user ID: ${this.state.defaultUserId}`);
    return this.state.defaultUserId;
  }

  // =============================================================================
  // USER MAPPING
  // =============================================================================

  async mapAllUsers(bookstackUserIds) {
    if (this.config.sync.skipUserMapping) {
      console.log('[INFO] Skipping user mapping, all content will use default user');
      return;
    }

    const uniqueIds = Array.from(bookstackUserIds).filter(id => id && typeof id === 'number');
    console.log(`[PROGRESS] Mapping ${uniqueIds.length} BookStack users...`);
    
    for (const userId of uniqueIds) {
      await this.mapUser(userId);
    }
  }

  async mapUser(bookstackUserId) {
    if (this.state.userMap[bookstackUserId]) {
      return this.state.userMap[bookstackUserId];
    }

    try {
      // Get user details from BookStack
      const userResponse = await this.bookstackClient.get(`/users/${bookstackUserId}`);
      const userData = userResponse.data;
      const userEmail = userData.email || this.config.wikijs.defaultUserEmail;

      // Find user in Wiki.js by email
      const wikijsUser = this.getWikiJSUserByEmail(userEmail);

      if (wikijsUser) {
        this.state.userMap[bookstackUserId] = wikijsUser.id;
        console.log(`[INFO] Mapped ${userEmail} (BS:${bookstackUserId} -> WJS:${wikijsUser.id})`);
      } else {
        console.log(`[WARN] User ${userEmail} not found in Wiki.js, using default`);
        this.state.userMap[bookstackUserId] = await this.getDefaultUserId();
      }

      return this.state.userMap[bookstackUserId];
    } catch (error) {
      console.error(`[ERROR] Failed to map user ${bookstackUserId}:`, error.message);
      this.stats.userMappingErrors++;
      return await this.getDefaultUserId();
    }
  }

  // =============================================================================
  // ASSET SYNC (IMAGES & ATTACHMENTS)
  // =============================================================================

  async syncAssets() {
    console.log('[PROGRESS] Syncing images and attachments...');
    
    // Fetch images
    const images = await this.paginateBookStack('/image-gallery');
    console.log(`[INFO] Found ${images.length} images`);
    
    for (const image of images) {
      await this.syncAsset('image', image);
    }

    // Fetch attachments
    const attachments = await this.paginateBookStack('/attachments');
    console.log(`[INFO] Found ${attachments.length} attachments`);
    
    for (const attachment of attachments) {
      await this.syncAsset('attachment', attachment);
    }
  }

  async syncAsset(type, asset) {
    const assetId = asset.id;
    const assetName = asset.name || path.basename(asset.path || `asset-${assetId}`);
    
    if (this.state.assetMap[assetId]) {
      console.log(`[SKIP] Asset ${assetName} (ID: ${assetId}) already synced`);
      return this.state.assetMap[assetId];
    }

    try {
      console.log(`[PROGRESS] Processing ${type}: ${assetName} (ID: ${assetId})`);
      
      // Download asset
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

      // Upload to Wiki.js if not dry run
      let wikijsPath = '/placeholder.jpg';
      
      if (!this.config.sync.dryRun) {
        console.log('[API] Uploading to Wiki.js...');
        wikijsPath = await this.uploadAssetToWikiJS(localPath, assetName);
      } else {
        console.log('[DRYRUN] Would upload asset to Wiki.js');
      }

      // Store mapping
      this.state.assetMap[assetId] = wikijsPath;
      this.stats.assetsUploaded++;

      // Clean up
      await fs.unlink(localPath);

      console.log(`[SUCCESS] Synced asset: ${wikijsPath}`);
      return wikijsPath;

    } catch (error) {
      console.error(`[ERROR] Asset sync failed ${assetName}:`, error.message);
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

    return response.data; // Wiki.js returns the path as string
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

    console.log(`[PROGRESS] Syncing ${sortedPages.length} pages...`);
    
    for (let i = 0; i < sortedPages.length; i++) {
      const page = sortedPages[i];
      console.log(`[PROGRESS] Page ${i + 1}/${sortedPages.length}: ${page.name}`);
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
      // Transform content
      const transformedMarkdown = await this.transformContent(page.markdown, page.html);

      // Get author IDs
      const createdBy = await this.mapUser(page.created_by);
      const updatedBy = await this.mapUser(page.updated_by);

      // Check if page exists
      const existingPage = await this.findWikiJSPage(pagePath);

      if (existingPage) {
        console.log(`[INFO] Updating page: ${pagePath}`);
        
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
        console.log(`[INFO] Creating page: ${pagePath}`);
        
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
          console.log(`[DRYRUN] Would create page: ${pagePath}`);
        }
        this.stats.pagesCreated++;
      }
    } catch (error) {
      console.error(`[ERROR] Page sync failed ${page.name}:`, error.message);
      this.stats.errors++;
    }
  }

  async transformContent(markdown, html) {
    let content = markdown || html || '';
    
    if (!content) {
      console.warn('[WARN] Empty content for page');
      return ' ';
    }

    // Replace BookStack image references
    // Format: ![alt](/uploads/images/gallery/2023-12/foo.png)
    content = content.replace(/!\[([^\]]*)\]\(\/uploads\/images\/gallery\/[^\/]+\/([^)]+)\)/g, (match, alt, filename) => {
      const imageEntry = Object.entries(this.state.assetMap).find(([id, assetPath]) => 
        assetPath && assetPath.includes(filename)
      );
      
      if (imageEntry) {
        const [, wikijsPath] = imageEntry;
        return `![${alt}](${wikijsPath})`;
      }
      
      console.warn(`[WARN] Image mapping not found: ${filename}`);
      return match;
    });

    // Replace attachment links
    // Format: [File Name](/attachments/123)
    content = content.replace(/\[([^\]]+)\]\(\/attachments\/(\d+)\)/g, (match, name, attachmentId) => {
      const wikijsPath = this.state.assetMap[attachmentId];
      if (wikijsPath) {
        return `[${name}](${wikijsPath})`;
      }
      console.warn(`[WARN] Attachment mapping not found: ID ${attachmentId}`);
      return match;
    });

    return content;
  }

  async findWikiJSPage(path) {
    const query = {
      query: `
        query FindPage($path: String!) {
          pages {
            single(by: { path: $path }) {
              id
              path
              title
            }
          }
        }
      `,
      variables: { path: path }
    };

    try {
      const response = await this.wikijsClient.post('', query);
      
      if (response.data.errors) {
        console.warn(`[WARN] GraphQL error finding page ${path}:`, JSON.stringify(response.data.errors));
        return null;
      }
      
      return response.data.data.pages.single;
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }
      console.warn(`[WARN] Error checking page existence:`, error.message);
      return null;
    }
  }

  async createWikiJSPage(pageData) {
    const mutation = {
      query: `
        mutation CreatePage($content: PageInput!) {
          pages {
            create(content: $content) {
              responseResult {
                succeeded
                errorCode
                message
              }
              page {
                id
                path
              }
            }
          }
        }
      `,
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
      throw new Error(`Failed to create page: ${result.responseResult.message}`);
    }
    
    return result.page;
  }

  async updateWikiJSPage(pageId, pageData) {
    const mutation = {
      query: `
        mutation UpdatePage($id: Int!, $content: PageInput!) {
          pages {
            update(id: $id, content: $content) {
              responseResult {
                succeeded
                errorCode
                message
              }
            }
          }
        }
      `,
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
      throw new Error(`Failed to update page: ${result.responseResult.message}`);
    }
  }

  // =============================================================================
  // STATE MANAGEMENT
  // =============================================================================

  async loadState() {
    try {
      const data = await fs.readFile(STATE_PATH, 'utf8');
      this.state = JSON.parse(data);
      console.log(`[INFO] Loaded sync state (last sync: ${this.state.lastSync || 'never'})`);
    } catch (error) {
      console.log('[INFO] No previous sync state found, starting fresh');
    }
  }

  async saveState() {
    this.state.lastSync = new Date().toISOString();
    await fs.writeFile(STATE_PATH, JSON.stringify(this.state, null, 2));
    console.log('[INFO] Sync state saved');
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
  // Load configuration
  let config = DEFAULT_CONFIG;
  
  try {
    const configFile = await fs.readFile(CONFIG_PATH, 'utf8');
    const userConfig = yaml.load(configFile);
    config = { ...config, ...userConfig };
    config.bookstack = { ...config.bookstack, ...(userConfig.bookstack || {}) };
    config.wikijs = { ...config.wikijs, ...(userConfig.wikijs || {}) };
    config.sync = { ...config.sync, ...(userConfig.sync || {}) };
  } catch (error) {
    console.log(`[INFO] No config file found at ${CONFIG_PATH}, using defaults`);
    console.log('       Run: node wiki_sync.js --init   to create a template');
  }

  // Parse CLI arguments
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

  // Run sync
  try {
    const sync = new BookStackToWikiJSSync(config);
    await sync.run();
  } catch (error) {
    console.error('[FATAL] Sync terminated:', error.message);
    process.exit(1);
  }
}

async function createTemplateConfig() {
  const template = `# BookStack to Wiki.js Sync Configuration
# Get BookStack API token from: Settings > API Tokens
# Get Wiki.js API key from: Administration > API Keys

bookstack:
  url: 'http://localhost:6875'          # Your BookStack base URL
  tokenId: 'YOUR_BOOKSTACK_TOKEN_ID'     # Numeric token ID
  tokenSecret: 'YOUR_BOOKSTACK_SECRET'   # Token secret string
  pageSize: 100                          # Items per API request

wikijs:
  url: 'http://localhost:3000'           # Your Wiki.js base URL
  apiKey: 'YOUR_WIKIJS_API_KEY'          # API key from Administration
  defaultUserEmail: 'admin@example.com'  # Must exist in Wiki.js

sync:
  assetsDir: './sync-assets'             # Temporary local storage
  hierarchySeparator: '/'                # Path separator for Wiki.js pages
  includeDrafts: false                   # Sync draft pages? (true/false)
  dryRun: false                          # Preview mode (true/false)
  skipUserMapping: false                 # Skip user mapping, use default user
`;

  await fs.writeFile(CONFIG_PATH, template);
  console.log(`[SUCCESS] Template config created: ${CONFIG_PATH}`);
  console.log('          Edit the file with your credentials before running');
}

// Execute if run directly
if (require.main === module) {
  main().catch(error => {
    console.error('[FATAL] Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = BookStackToWikiJSSync;
