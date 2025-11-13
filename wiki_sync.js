#!/usr/bin/env node

/**
 * BookStack to Wiki.js Sync Script
 * Features: Full hierarchy sync, attachments/images, user mapping, incremental sync
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

// Default configuration - override in config.yaml
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
    uploadPath: '/uploads/bookstack-sync',
    defaultUserEmail: 'admin@example.com'
  },
  sync: {
    assetsDir: './sync-assets',
    hierarchySeparator: '/',
    includeDrafts: false,
    dryRun: false,
    maxRetries: 3,
    retryDelay: 2000
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
      userMap: {}
    };
    this.stats = {
      pagesCreated: 0,
      pagesUpdated: 0,
      assetsUploaded: 0,
      errors: 0
    };
  }

  async initialize() {
    console.log('[INFO] Initializing BookStack -> Wiki.js Sync...');
    
    // Validate configuration
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
      validateStatus: function (status) {
        return status < 500; // Fail on server errors
      }
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
    
    console.log('[INFO] Initialization complete');
  }

  validateConfig() {
    if (!this.config.bookstack.url || !this.config.bookstack.url.startsWith('http')) {
      throw new Error('Invalid bookstack.url configuration');
    }
    if (!this.config.wikijs.url || !this.config.wikijs.url.startsWith('http')) {
      throw new Error('Invalid wikijs.url configuration');
    }
  }

  async run() {
    try {
      await this.initialize();
      
      if (this.config.sync.dryRun) {
        console.log('[DRY RUN] Preview mode - no changes will be made');
      }

      console.log('[INFO] Fetching BookStack content hierarchy...');
      const hierarchy = await this.fetchBookStackHierarchy();
      console.log(`[INFO] Found ${hierarchy.shelves.length} shelves, ${hierarchy.books.length} books, ${hierarchy.chapters.length} chapters, ${hierarchy.pages.length} pages`);

      console.log('[INFO] Mapping users...');
      await this.mapAllUsers(hierarchy.users);
      
      console.log('[INFO] Processing assets...');
      await this.syncAssets();

      console.log('[INFO] Syncing pages...');
      await this.syncPages(hierarchy);

      console.log('[INFO] Saving sync state...');
      await this.saveState();

      this.printStats();

    } catch (error) {
      console.error('[ERROR] Sync failed:', error.message);
      if (error.response) {
        console.error('[ERROR] API Response:', {
          status: error.response.status,
          data: error.response.data
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

    console.log('[INFO] Fetching shelves...');
    const shelves = await this.paginateBookStack('/shelves');
    hierarchy.shelves = shelves;

    console.log('[INFO] Fetching books...');
    const books = await this.paginateBookStack('/books');
    hierarchy.books = books;

    console.log('[INFO] Fetching chapters...');
    const chapters = await this.paginateBookStack('/chapters');
    hierarchy.chapters = chapters;

    console.log('[INFO] Fetching pages...');
    const pages = await this.paginateBookStack('/pages');
    
    console.log('[INFO] Enriching page data...');
    for (const page of pages) {
      if (!this.config.sync.includeDrafts && page.draft) {
        continue;
      }

      try {
        // Get detailed page info including markdown
        const pageResponse = await this.bookstackClient.get(`/pages/${page.id}`);
        const pageDetail = pageResponse.data;
        
        // Extract user IDs safely
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
          console.warn(`[WARN] Unexpected response from ${endpoint}:`, response.data);
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
  // USER MAPPING
  // =============================================================================

  async mapAllUsers(bookstackUserIds) {
    const uniqueIds = Array.from(bookstackUserIds).filter(id => id && typeof id === 'number');
    console.log(`[INFO] Mapping ${uniqueIds.length} BookStack users to Wiki.js...`);
    
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

      // Query user in Wiki.js by email using GraphQL variables
      const query = {
        query: `
          query GetUserByEmail($email: String!) {
            users {
              list(filter: { email: $email }) {
                id
                email
              }
            }
          }
        `,
        variables: { email: userEmail }
      };

      const response = await this.wikijsClient.post('', query);
      
      if (response.data.errors) {
        console.error(`[ERROR] GraphQL error finding user ${userEmail}:`, response.data.errors);
        throw new Error(`GraphQL error: ${response.data.errors[0].message}`);
      }

      const wikijsUser = response.data.data?.users?.list?.[0];

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
      return await this.getDefaultUserId();
    }
  }

  async getDefaultUserId() {
    if (this.state.defaultUserId) {
      return this.state.defaultUserId;
    }

    try {
      const query = {
        query: `
          query GetDefaultUser($email: String!) {
            users {
              list(filter: { email: $email }) {
                id
              }
            }
          }
        `,
        variables: { email: this.config.wikijs.defaultUserEmail }
      };

      const response = await this.wikijsClient.post('', query);
      
      if (response.data.errors) {
        throw new Error(`GraphQL error: ${response.data.errors[0].message}`);
      }

      const user = response.data.data?.users?.list?.[0];
      
      if (!user) {
        throw new Error(`Default user ${this.config.wikijs.defaultUserEmail} not found in Wiki.js`);
      }
      
      this.state.defaultUserId = user.id;
      return this.state.defaultUserId;
    } catch (error) {
      console.error(`[ERROR] Failed to get default user:`, error.message);
      throw error;
    }
  }

  // =============================================================================
  // ASSET SYNC (IMAGES & ATTACHMENTS)
  // =============================================================================

  async syncAssets() {
    console.log('[INFO] Syncing images and attachments...');
    
    // Fetch all images from BookStack
    const images = await this.paginateBookStack('/image-gallery');
    console.log(`[INFO] Found ${images.length} images`);
    
    for (const image of images) {
      await this.syncAsset('image', image);
    }

    // Fetch all attachments
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
      console.log(`[INFO] Processing ${type}: ${assetName} (ID: ${assetId})`);
      
      // Download asset from BookStack
      const downloadUrl = type === 'image' 
        ? `${this.config.bookstack.url}${asset.path}`
        : `${this.config.bookstack.url}/attachments/${assetId}`;
      
      console.log(`[INFO] Downloading from: ${downloadUrl}`);
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

      console.log(`[INFO] Downloaded to: ${localPath}`);

      // Upload to Wiki.js
      console.log('[INFO] Uploading to Wiki.js...');
      const wikijsPath = await this.uploadAssetToWikiJS(localPath, assetName);

      // Store mapping
      this.state.assetMap[assetId] = wikijsPath;
      this.stats.assetsUploaded++;

      // Clean up local file
      await fs.unlink(localPath);

      console.log(`[SUCCESS] Synced asset: ${wikijsPath}`);
      return wikijsPath;

    } catch (error) {
      console.error(`[ERROR] Failed to sync ${type} ${assetName}:`, error.message);
      this.stats.errors++;
      // Continue with other assets
      return null;
    }
  }

  async uploadAssetToWikiJS(filePath, originalName) {
    try {
      // Read file
      const fileBuffer = await fs.readFile(filePath);
      
      // Create form data
      const form = new FormData();
      form.append('media', fileBuffer, {
        filename: originalName,
        contentType: 'application/octet-stream'
      });

      // Use Wiki.js upload endpoint
      const uploadEndpoint = `${this.config.wikijs.url}/u`;
      
      const response = await axios.post(uploadEndpoint, form, {
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${this.config.wikijs.apiKey}`
        },
        timeout: 60000 // Larger timeout for file uploads
      });

      if (response.data.error) {
        throw new Error(`Upload failed: ${response.data.error}`);
      }

      // Wiki.js returns the relative path
      return response.data;
      
    } catch (error) {
      console.error('[ERROR] Asset upload failed:', error.message);
      throw error;
    }
  }

  // =============================================================================
  // PAGE SYNC
  // =============================================================================

  async syncPages(hierarchy) {
    // Sort pages by path depth to ensure parent pages are created first
    const sortedPages = hierarchy.pages.sort((a, b) => {
      const aDepth = this.getPagePath(a).split('/').length;
      const bDepth = this.getPagePath(b).split('/').length;
      return aDepth - bDepth;
    });

    console.log(`[INFO] Syncing ${sortedPages.length} pages...`);
    
    for (const [index, page] of sortedPages.entries()) {
      console.log(`[PROGRESS] Processing page ${index + 1}/${sortedPages.length}: ${page.name}`);
      await this.syncPage(page, hierarchy);
    }
  }

  getPagePath(page) {
    const parts = [];
    
    if (page.shelfSlug) parts.push(page.shelfSlug);
    if (page.bookSlug) parts.push(page.bookSlug);
    if (page.chapterSlug) parts.push(page.chapterSlug);
    parts.push(page.slug);
    
    // Ensure path is lowercase and URL-safe
    return parts
      .join(this.config.sync.hierarchySeparator)
      .toLowerCase()
      .replace(/[^a-z0-9\/\-_]/g, '-');
  }

  async syncPage(page, hierarchy) {
    const pagePath = this.getPagePath(page);
    
    try {
      // Transform content to replace asset URLs
      const transformedMarkdown = await this.transformContent(page.markdown, page.html);

      // Get author IDs
      const createdBy = await this.mapUser(page.created_by);
      const updatedBy = await this.mapUser(page.updated_by);

      // Check if page exists in Wiki.js
      const existingPage = await this.findWikiJSPage(pagePath);

      if (existingPage) {
        // Update existing page
        console.log(`[INFO] Updating existing page: ${pagePath}`);
        
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
        // Create new page
        console.log(`[INFO] Creating new page: ${pagePath}`);
        
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
        }
        this.stats.pagesCreated++;
      }
    } catch (error) {
      console.error(`[ERROR] Failed to sync page ${page.name}:`, error.message);
      this.stats.errors++;
    }
  }

  async transformContent(markdown, html) {
    let content = markdown || html || '';
    
    if (!content) {
      console.warn('[WARN] Empty content for page');
      return '';
    }

    // Replace BookStack image references
    // Pattern: ![alt](/uploads/images/gallery/2023-12/foo.png)
    content = content.replace(/!\[([^\]]*)\]\(\/uploads\/images\/gallery\/[^\/]+\/([^)]+)\)/g, (match, alt, filename) => {
      // Find image in our asset map
      const imageEntry = Object.entries(this.state.assetMap).find(([id, assetPath]) => 
        assetPath && assetPath.includes(filename)
      );
      
      if (imageEntry) {
        const [, wikijsPath] = imageEntry;
        return `![${alt}](${wikijsPath})`;
      }
      
      console.warn(`[WARN] Could not find image mapping for: ${filename}`);
      return match; // Keep original if not found
    });

    // Replace attachment links
    // Pattern: [File Name](/attachments/123)
    content = content.replace(/\[([^\]]+)\]\(\/attachments\/(\d+)\)/g, (match, name, attachmentId) => {
      const wikijsPath = this.state.assetMap[attachmentId];
      if (wikijsPath) {
        return `[${name}](${wikijsPath})`;
      }
      console.warn(`[WARN] Could not find attachment mapping for ID: ${attachmentId}`);
      return match;
    });

    return content;
  }

  async findWikiJSPage(path) {
    const query = {
      query: `
        query FindPageByPath($path: String!) {
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
        console.error(`[ERROR] GraphQL error finding page ${path}:`, response.data.errors);
        return null;
      }
      
      return response.data.data.pages.single;
    } catch (error) {
      if (error.response?.status === 404) {
        return null; // Page doesn't exist
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
                slug
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
          publishStartDate: pageData.publishedAt,
          authorId: pageData.authorId,
          creatorId: pageData.creatorId
        }
      }
    };

    const response = await this.wikijsClient.post('', mutation);
    
    if (response.data.errors) {
      throw new Error(`GraphQL error: ${response.data.errors[0].message}`);
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
      throw new Error(`GraphQL error: ${response.data.errors[0].message}`);
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
    console.log(`Errors: ${this.stats.errors}`);
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
    
    // Merge nested objects
    config.bookstack = { ...config.bookstack, ...(userConfig.bookstack || {}) };
    config.wikijs = { ...config.wikijs, ...(userConfig.wikijs || {}) };
    config.sync = { ...config.sync, ...(userConfig.sync || {}) };
    
  } catch (error) {
    console.log(`[INFO] No config file found at ${CONFIG_PATH}, using defaults`);
    console.log('       Run with --init to create a template config file');
  }

  // Handle CLI arguments
  const args = process.argv.slice(2);
  
  if (args.includes('--init')) {
    await createTemplateConfig();
    return;
  }

  if (args.includes('--dry-run')) {
    config.sync.dryRun = true;
  }

  try {
    // Run sync
    const sync = new BookStackToWikiJSSync(config);
    await sync.run();
  } catch (error) {
    console.error('[FATAL] Sync failed:', error.message);
    process.exit(1);
  }
}

async function createTemplateConfig() {
  const template = `# BookStack to Wiki.js Sync Configuration
bookstack:
  url: 'http://localhost:6875'          # Your BookStack URL
  tokenId: 'YOUR_BOOKSTACK_TOKEN_ID'     # From BookStack > Settings > API Tokens
  tokenSecret: 'YOUR_BOOKSTACK_SECRET'   # From BookStack > Settings > API Tokens
  pageSize: 100                          # Items per API request

wikijs:
  url: 'http://localhost:3000'           # Your Wiki.js URL
  apiKey: 'YOUR_WIKIJS_API_KEY'          # From Wiki.js > Administration > API Keys
  defaultUserEmail: 'admin@example.com'  # Fallback user if LDAP mapping fails
  uploadPath: '/uploads/bookstack-sync'  # Where to store synced assets

sync:
  assetsDir: './sync-assets'             # Temporary local storage directory
  hierarchySeparator: '/'                # Path separator for Wiki.js
  includeDrafts: false                   # Sync draft pages?
  dryRun: false                          # Preview changes without applying
  maxRetries: 3                          # API retry attempts
  retryDelay: 2000                       # ms between retries
`;

  await fs.writeFile(CONFIG_PATH, template);
  console.log(`[INFO] Created template config file: ${CONFIG_PATH}`);
  console.log('       Please edit with your actual credentials and settings');
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('[FATAL] Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = BookStackToWikiJSSync;
