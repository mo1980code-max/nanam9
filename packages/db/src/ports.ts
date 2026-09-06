/**
 * The database port: what the application is allowed to ask for.
 *
 * WHY A PORT AND NOT `prisma.game.findMany(...)` IN CONTROLLERS
 * ------------------------------------------------------------
 * 1. Services stay unit-testable without a database (an in-memory fake that
 *    implements this interface is ~100 lines and makes the auth/game services
 *    testable in milliseconds).
 * 2. Two drivers can share one contract: the SQL driver (node-postgres, the one
 *    this repo verifies end-to-end) and the Prisma driver (`npm run
 *    build:prisma-driver`, for installs that run `prisma generate`). A single
 *    contract test suite runs against both.
 * 3. Every query the product can issue is visible in one file. "Which columns
 *    does the front page touch?" is answerable by reading, not by grepping.
 *
 * Rows are camelCase (the connection layer camelises) and dates are `Date`,
 * exactly what Prisma Client would have handed back — so swapping drivers does
 * not ripple into the services.
 */

export type ID = string;

export type Timestamps = { createdAt: Date; updatedAt: Date };
export type SoftDelete = { deletedAt: Date | null };

// ───────────────────────────────── rows ─────────────────────────────────

export type RoleRow = {
  id: ID;
  slug: string;
  name: string;
  description: string | null;
  level: number;
  isSystem: boolean;
} & Timestamps;

export type PermissionRow = {
  id: ID;
  slug: string;
  module: string;
  action: string;
  description: string | null;
  createdAt: Date;
};

export type UserRow = {
  id: ID;
  email: string | null;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  passwordHash: string | null;
  locale: string;
  timezone: string | null;
  bio: string | null;
  website: string | null;
  status: string;
  roleId: ID;
  xp: number;
  level: number;
  playsCount: number;
  commentsCount: number;
  twoFactorSecret: string | null;
  twoFactorEnabled: boolean;
  twoFactorBackupCodes: string[];
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** joined on demand */
  role?: Pick<RoleRow, 'id' | 'slug' | 'name' | 'level'>;
  permissions?: string[];
  premium?: boolean;
};

export type OAuthAccountRow = {
  id: ID;
  userId: ID;
  provider: string;
  providerUserId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  tokenExpiresAt: Date | null;
  createdAt: Date;
};

export type SessionRow = {
  id: ID;
  userId: ID;
  tokenHash: string;
  kind: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

export type CategoryRow = {
  id: ID;
  slug: string;
  parentId: ID | null;
  name: string;
  nameEn: string | null;
  description: string | null;
  icon: string | null;
  thumbnailUrl: string | null;
  color: string | null;
  sortOrder: number;
  isVisible: boolean;
  gamesCount: number;
  seoTitle: string | null;
  seoDescription: string | null;
  seoKeywords: string | null;
  canonicalUrl: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  parent?: Pick<CategoryRow, 'slug' | 'name'> | null;
  children?: CategoryRow[];
};

export type TagRow = {
  id: ID;
  slug: string;
  name: string;
  scope: string;
  gamesCount: number;
  createdAt: Date;
};

export type GameAssetRow = {
  id: ID;
  gameId: ID;
  kind: string;
  url: string;
  storageKey: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  alt: string | null;
  sortOrder: number;
  createdAt: Date;
};

export type GameRow = {
  id: ID;
  slug: string;
  title: string;
  titleEn: string | null;
  description: string | null;
  descriptionEn: string | null;
  instructions: string | null;
  developer: string | null;
  version: string | null;
  releaseYear: number | null;
  kind: string;
  url: string;
  filePath: string | null;
  width: number | null;
  height: number | null;
  orientation: string;
  sizeKb: number | null;
  thumbnailUrl: string;
  bannerUrl: string | null;
  gallery: string[];
  status: string;
  featured: boolean;
  premium: boolean;
  ageRating: string;
  providerSlug: string | null;
  providerGameId: string | null;
  providerUrl: string | null;
  sourceHash: string | null;
  plays: number;
  uniquePlays: number;
  likesCount: number;
  dislikesCount: number;
  ratingAvg: number;
  ratingCount: number;
  commentsCount: number;
  favoritesCount: number;
  publishedAt: Date | null;
  seoTitle: string | null;
  seoDescription: string | null;
  seoKeywords: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
  meta: Record<string, unknown>;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  categories?: Pick<CategoryRow, 'id' | 'slug' | 'name'>[];
  tags?: Pick<TagRow, 'id' | 'slug' | 'name'>[];
  assets?: GameAssetRow[];
};

export type CommentRow = {
  id: ID;
  gameId: ID | null;
  blogPostId: ID | null;
  userId: ID | null;
  parentId: ID | null;
  authorName: string | null;
  authorEmail: string | null;
  authorIpHash: string | null;
  body: string;
  status: string;
  likesCount: number;
  dislikesCount: number;
  reportsCount: number;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  user?: { id: ID; username: string; displayName: string | null; avatarUrl: string | null } | null;
  children?: CommentRow[];
};

export type RatingRow = {
  id: ID;
  userId: ID;
  gameId: ID;
  stars: number;
  review: string | null;
  createdAt: Date;
  updatedAt: Date;
  user?: { id: ID; username: string; displayName: string | null; avatarUrl: string | null } | null;
};

export type FavoriteRow = { id: ID; userId: ID; gameId: ID; createdAt: Date };

export type PlaylistRow = {
  id: ID;
  userId: ID;
  slug: string;
  name: string;
  description: string | null;
  visibility: string;
  coverUrl: string | null;
  gamesCount: number;
  shareToken: string | null;
  createdAt: Date;
  updatedAt: Date;
  user?: { id: ID; username: string; displayName: string | null };
};

export type GamePlayRow = {
  id: number;
  gameId: ID;
  userId: ID | null;
  sessionId: string | null;
  device: string;
  country: string | null;
  referrer: string | null;
  utmSource: string | null;
  durationMs: number | null;
  completed: boolean;
  startedAt: Date;
  game?: Pick<GameRow, 'id' | 'slug' | 'title' | 'thumbnailUrl'>;
};

export type DailyStatRow = {
  day: string;
  dimension: string;
  key: string;
  gameId: ID | null;
  views: number;
  plays: number;
  uniqueVisitors: number;
  avgDurationMs: number | null;
  bounceRate: number | null;
};

export type AchievementRow = {
  id: ID;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  tier: string;
  xp: number;
  rule: Record<string, unknown>;
  isHidden: boolean;
  createdAt: Date;
  progress?: number;
  unlockedAt?: Date | null;
};

export type NotificationRow = {
  id: number;
  userId: ID;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  data: Record<string, unknown> | null;
  readAt: Date | null;
  createdAt: Date;
};

export type AdRow = {
  id: ID;
  name: string;
  placement: string;
  type: string;
  status: string;
  code: string | null;
  imageUrl: string | null;
  linkUrl: string | null;
  priority: number;
  startsAt: Date | null;
  endsAt: Date | null;
  impressions: number;
  clicks: number;
  targeting: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type PageRow = {
  id: ID;
  slug: string;
  title: string;
  titleEn: string | null;
  body: string | null;
  blocks: unknown[];
  template: string;
  status: string;
  isIndexed: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  canonicalUrl: string | null;
  sortOrder: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BlogCategoryRow = {
  id: ID;
  slug: string;
  name: string;
  description: string | null;
  parentId: ID | null;
  sortOrder: number;
  postsCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type BlogPostRow = {
  id: ID;
  slug: string;
  title: string;
  excerpt: string | null;
  body: string;
  coverImage: string | null;
  authorId: ID;
  categoryId: ID | null;
  status: string;
  publishedAt: Date | null;
  readingMinutes: number;
  views: number;
  seoTitle: string | null;
  seoDescription: string | null;
  canonicalUrl: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  author?: { id: ID; username: string; displayName: string | null; avatarUrl: string | null };
  category?: Pick<BlogCategoryRow, 'id' | 'slug' | 'name'> | null;
  tags?: Pick<TagRow, 'id' | 'slug' | 'name'>[];
};

export type SettingRow = {
  key: string;
  value: unknown;
  type: string;
  group: string;
  isPublic: boolean;
  description: string | null;
  updatedAt: Date;
};

export type SectionRow = {
  id: ID;
  page: string;
  kind: string;
  title: string | null;
  titleEn: string | null;
  subtitle: string | null;
  config: Record<string, unknown>;
  sortOrder: number;
  isVisible: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ThemeRow = {
  id: ID;
  slug: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
  config: Record<string, unknown>;
  previewUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RedirectRow = {
  id: ID;
  sourcePath: string;
  targetPath: string;
  statusCode: number;
  isActive: boolean;
  hits: number;
  createdAt: Date;
};

export type ActivityLogRow = {
  id: number;
  actorId: ID | null;
  actorLabel: string | null;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
};

export type ReportRow = {
  id: ID;
  reporterId: ID | null;
  targetKind: string;
  targetId: string;
  reason: string;
  details: string | null;
  status: string;
  moderatorId: ID | null;
  resolution: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  reporter?: { id: ID; username: string } | null;
  moderator?: { id: ID; username: string } | null;
};

export type PlanRow = {
  id: ID;
  slug: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  interval: string;
  removesAds: boolean;
  features: string[];
  stripePriceId: string | null;
  paypalPlanId: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

export type SubscriptionRow = {
  id: ID;
  userId: ID;
  planId: ID;
  status: string;
  provider: string;
  providerSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
  updatedAt: Date;
  plan?: Pick<PlanRow, 'id' | 'slug' | 'name' | 'priceCents' | 'interval' | 'removesAds'>;
};

export type PaymentRow = {
  id: number;
  userId: ID;
  subscriptionId: ID | null;
  provider: string;
  providerPaymentId: string | null;
  amountCents: number;
  currency: string;
  status: string;
  meta: Record<string, unknown> | null;
  createdAt: Date;
};

export type ProviderRow = {
  id: ID;
  slug: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  feedUrl: string | null;
  apiKey: string | null;
  isActive: boolean;
  syncIntervalMinutes: number;
  lastSyncAt: Date | null;
  lastStatus: string | null;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type ProviderItemRow = {
  id: number;
  providerId: ID;
  providerGameId: string;
  sourceHash: string;
  title: string | null;
  payload: Record<string, unknown>;
  status: string;
  gameId: ID | null;
  error: string | null;
  fetchedAt: Date;
  importedAt: Date | null;
};

export type ImportJobRow = {
  id: number;
  providerId: ID;
  status: string;
  triggeredBy: string;
  actorId: ID | null;
  cursor: string | null;
  fetchedCount: number;
  importedCount: number;
  duplicateCount: number;
  failedCount: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  createdAt: Date;
  provider?: Pick<ProviderRow, 'slug' | 'name'>;
};

export type ReleaseRow = {
  id: ID;
  version: string;
  channel: string;
  notes: string | null;
  packageUrl: string | null;
  checksumSha256: string | null;
  sizeBytes: number | null;
  isMandatory: boolean;
  minSchemaVersion: number | null;
  releasedAt: Date | null;
  createdAt: Date;
};

export type BackupRow = {
  id: ID;
  kind: string;
  status: string;
  path: string | null;
  storageKey: string | null;
  sizeBytes: number | null;
  checksumSha256: string | null;
  trigger: string;
  meta: Record<string, unknown> | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
};

// ───────────────────────────── query options ─────────────────────────────

export type Page = { page: number; perPage: number; offset: number };
export type List<T> = { items: T[]; total: number };

export type GameListFilter = {
  status?: string | string[];
  /** admin listings only: include soft-deleted rows */
  includeDeleted?: boolean;
  /** only published, non-deleted games unless `status` is given */
  publishedOnly?: boolean;
  categorySlug?: string;
  categorySlugs?: string[];
  tagSlug?: string;
  q?: string;
  featured?: boolean;
  premium?: boolean;
  ageRating?: string;
  kind?: string;
  ids?: ID[];
  excludeId?: ID;
  /** 'ar' | 'en' — decides which title/description the search vector prefers */
  locale?: string;
  sort?: 'newest' | 'popular' | 'top_rated' | 'most_liked' | 'trending' | 'random' | 'az' | 'updated';
  page?: Page;
  with?: ('categories' | 'tags')[];
};

export type CommentListFilter = {
  gameId?: ID;
  blogPostId?: ID;
  parentId?: ID | null;
  status?: string | string[];
  userId?: ID;
  sort?: 'newest' | 'oldest' | 'top';
  page?: Page;
  /** build the nested tree instead of a flat page */
  tree?: boolean;
};

export type UserListFilter = {
  q?: string;
  status?: string;
  roleSlug?: string;
  sort?: 'newest' | 'xp' | 'plays' | 'username';
  page?: Page;
};

export type AdminGameFilter = GameListFilter & { includeDeleted?: boolean };

export type StatsRange = { from: Date; to: Date };

/** Metrics an achievement rule can reference ({ type: 'plays', threshold: 10 }). */
export type UserActionCounts = {
  plays: number;
  ratings: number;
  comments: number;
  favorites: number;
  playlists: number;
};

export type DashboardStats = {
  totals: {
    games: number;
    publishedGames: number;
    users: number;
    plays: number;
    comments: number;
    pendingComments: number;
    openReports: number;
    revenueCents: number;
    activeSubscriptions: number;
  };
  timeline: { day: string; views: number; plays: number; uniqueVisitors: number }[];
  topGames: { id: ID; slug: string; title: string; thumbnailUrl: string; plays: number; ratingAvg: number }[];
  sources: { source: string; plays: number }[];
  devices: { device: string; plays: number }[];
  countries: { country: string; plays: number }[];
  categories: { slug: string; name: string; gamesCount: number }[];
};

// ─────────────────────────── repository interfaces ───────────────────────────

export interface CatalogRepository {
  findGameBySlug(slug: string, withRelations?: boolean): Promise<GameRow | null>;
  findGameById(id: ID, withRelations?: boolean): Promise<GameRow | null>;
  findGameBySourceHash(hash: string): Promise<GameRow | null>;
  listGames(filter: GameListFilter): Promise<List<GameRow>>;
  relatedGames(game: Pick<GameRow, 'id' | 'slug'>, limit?: number): Promise<GameRow[]>;
  randomGames(limit?: number, categorySlug?: string): Promise<GameRow[]>;
  createGame(data: Partial<GameRow> & { slug: string; title: string; url: string; thumbnailUrl: string }): Promise<GameRow>;
  updateGame(id: ID, patch: Partial<GameRow>): Promise<GameRow | null>;
  deleteGame(id: ID, options?: { hard?: boolean }): Promise<boolean>;
  incrementGame(id: ID, field: 'plays' | 'uniquePlays' | 'likesCount' | 'dislikesCount' | 'commentsCount' | 'favoritesCount', by?: number): Promise<void>;
  recalcGameCounters(id: ID): Promise<void>;
  setGameCategories(gameId: ID, categoryIds: ID[]): Promise<void>;
  /** Persist a drag-and-drop ordering inside one category (category_game.position). */
  reorderCategoryGames(categoryId: ID, orderedGameIds: ID[]): Promise<void>;
  setGameTags(gameId: ID, tags: (string | { slug: string; name: string })[]): Promise<TagRow[]>;
  addAsset(asset: Omit<GameAssetRow, 'id' | 'createdAt'>): Promise<GameAssetRow>;
  listAssets(gameId: ID): Promise<GameAssetRow[]>;
  deleteAsset(id: ID): Promise<boolean>;

  listCategories(options?: { visibleOnly?: boolean; includeHiddenCount?: boolean }): Promise<CategoryRow[]>;
  categoryTree(options?: { visibleOnly?: boolean }): Promise<CategoryRow[]>;
  findCategoryBySlug(slug: string): Promise<CategoryRow | null>;
  findCategoryById(id: ID): Promise<CategoryRow | null>;
  createCategory(data: Partial<CategoryRow> & { slug: string; name: string }): Promise<CategoryRow>;
  updateCategory(id: ID, patch: Partial<CategoryRow>): Promise<CategoryRow | null>;
  deleteCategory(id: ID): Promise<boolean>;
  reorderCategories(orderedIds: ID[]): Promise<void>;

  listTags(options?: { scope?: string; q?: string; limit?: number }): Promise<TagRow[]>;
  findTagBySlug(slug: string, scope?: string): Promise<TagRow | null>;
  upsertTags(tags: (string | { slug: string; name: string })[], scope?: string): Promise<TagRow[]>;
}

export interface SocialRepository {
  listComments(filter: CommentListFilter): Promise<List<CommentRow>>;
  findCommentById(id: ID): Promise<CommentRow | null>;
  createComment(data: Partial<CommentRow> & { body: string }): Promise<CommentRow>;
  updateComment(id: ID, patch: Partial<CommentRow>): Promise<CommentRow | null>;
  deleteComment(id: ID, options?: { hard?: boolean }): Promise<boolean>;
  countCommentsByStatus(): Promise<Record<string, number>>;

  /** Returns the stored vote (+1/-1) or null when the user has none. */
  vote(input: { userId: ID; targetKind: string; targetId: string; value: 1 | -1 }): Promise<{ value: 1 | -1; changed: boolean }>;
  removeVote(input: { userId: ID; targetKind: string; targetId: string }): Promise<boolean>;
  votesFor(userId: ID | null, targetKind: string, targetIds: ID[]): Promise<Record<ID, 1 | -1>>;

  rate(input: { userId: ID; gameId: ID; stars: number; review?: string | null }): Promise<RatingRow>;
  ratingFor(userId: ID | null, gameId: ID): Promise<RatingRow | null>;
  listRatings(gameId: ID, page?: Page): Promise<List<RatingRow>>;
  ratingBreakdown(gameId: ID): Promise<{ stars: number; count: number }[]>;

  toggleFavorite(userId: ID, gameId: ID): Promise<{ favorited: boolean }>;
  listFavorites(userId: ID, page?: Page): Promise<List<GameRow>>;
  isFavorite(userId: ID | null, gameId: ID): Promise<boolean>;

  createPlaylist(data: { userId: ID; slug: string; name: string; description?: string | null; visibility?: string }): Promise<PlaylistRow>;
  listPlaylists(userId: ID): Promise<PlaylistRow[]>;
  findPlaylist(idOrToken: string, userId?: ID | null): Promise<PlaylistRow | null>;
  addGameToPlaylist(playlistId: ID, gameId: ID, position?: number): Promise<boolean>;
  removeGameFromPlaylist(playlistId: ID, gameId: ID): Promise<boolean>;
  playlistGames(playlistId: ID): Promise<GameRow[]>;
  /** Which of this user's playlists contain the game — one query, no N+1. */
  playlistsContaining(userId: ID, gameId: ID): Promise<PlaylistRow[]>;
  updatePlaylist(id: ID, patch: Partial<PlaylistRow>): Promise<PlaylistRow | null>;
  deletePlaylist(id: ID): Promise<boolean>;

  createReport(data: { reporterId?: ID | null; targetKind: string; targetId: string; reason: string; details?: string | null }): Promise<ReportRow>;
  /** One reporter may only report a target once — without this, reports_count is
   *  inflatable by a single angry user (and it drives auto-hiding). */
  findReport(reporterId: ID, targetKind: string, targetId: string): Promise<ReportRow | null>;
  listReports(filter?: { status?: string; page?: Page }): Promise<List<ReportRow>>;
  resolveReport(id: ID, input: { moderatorId: ID; status: string; resolution?: string | null }): Promise<ReportRow | null>;
}

export interface IdentityRepository {
  findUserById(id: ID, withRole?: boolean): Promise<UserRow | null>;
  findUserByLogin(login: string): Promise<UserRow | null>;
  findUserByEmail(email: string): Promise<UserRow | null>;
  findUserByUsername(username: string): Promise<UserRow | null>;
  /** Includes `passwordHash`. Authentication only — must never leave the service. */
  findUserCredentials(login: string): Promise<(UserRow & { passwordHash: string | null }) | null>;
  createUser(data: Partial<UserRow> & { username: string; roleId: ID }): Promise<UserRow>;
  updateUser(id: ID, patch: Partial<UserRow>): Promise<UserRow | null>;
  deleteUser(id: ID, options?: { hard?: boolean; ban?: boolean }): Promise<boolean>;
  listUsers(filter?: UserListFilter): Promise<List<UserRow>>;
  countUsers(): Promise<number>;
  touchLogin(id: ID, ip: string | null): Promise<void>;

  createSession(data: { userId: ID; tokenHash: string; kind?: string; userAgent?: string | null; ip?: string | null; expiresAt: Date }): Promise<SessionRow>;
  findSessionByHash(tokenHash: string): Promise<SessionRow | null>;
  touchSession(id: ID): Promise<void>;
  revokeSession(id: ID): Promise<boolean>;
  revokeSessionsForUser(userId: ID, exceptId?: ID): Promise<number>;
  listSessions(userId: ID): Promise<SessionRow[]>;
  deleteExpiredSessions(): Promise<number>;

  findOAuthAccount(provider: string, providerUserId: string): Promise<OAuthAccountRow | null>;
  findOAuthAccountsForUser(userId: ID): Promise<OAuthAccountRow[]>;
  upsertOAuthAccount(data: Omit<OAuthAccountRow, 'id' | 'createdAt'> & { accessToken?: string | null; refreshToken?: string | null }): Promise<OAuthAccountRow>;
  /** Unlinks one provider from one user. The caller must first prove the account
   *  keeps at least one way to sign in (a password or another provider). */
  deleteOAuthAccount(id: ID): Promise<boolean>;

  listRoles(): Promise<RoleRow[]>;
  findRoleBySlug(slug: string): Promise<RoleRow | null>;
  listPermissions(): Promise<PermissionRow[]>;
  permissionsForRoleIds(roleIds: ID[]): Promise<string[]>;
  /** Idempotently writes the permission catalogue and role→permission wiring. */
  syncRbac(catalogue: { permissions: { slug: string; module: string; action: string }[]; roles: { slug: string; name: string; level: number; permissions: string[] }[] }): Promise<void>;
}

export interface EngagementRepository {
  recordPlay(input: {
    gameId: ID;
    userId?: ID | null;
    sessionId?: string | null;
    device?: string;
    country?: string | null;
    referrer?: string | null;
    utmSource?: string | null;
    /** Defaults to now(). The seeder and any backfill pass a historical time. */
    at?: Date | null;
    /** Session length; feeds avg_duration_ms in daily_stats. */
    durationMs?: number | null;
    /** The frame reported the game was finished — drives completion-rate analytics. */
    completed?: boolean | null;
  }): Promise<{ firstPlayOfSession: boolean }>;
  /** `gameId` narrows the history to one game (per-game play count, last played). */
  playHistory(input: { userId?: ID | null; sessionId?: string | null; gameId?: ID | null; page?: Page }): Promise<List<GamePlayRow>>;
  continuePlaying(input: { userId?: ID | null; sessionId?: string | null; limit?: number }): Promise<GameRow[]>;

  rollupDailyStats(day?: Date): Promise<{ upserted: number }>;
  /** Rows in game_plays (optionally since a date). The seed uses it to stay
   *  idempotent; the admin screen uses it to label the tracked-session total. */
  countPlays(since?: Date): Promise<number>;
  dashboard(range?: StatsRange): Promise<DashboardStats>;
  gameStats(gameId: ID, range?: StatsRange): Promise<{ day: string; plays: number; uniqueVisitors: number }[]>;

  /** One row, five counters — what achievement rules are evaluated against. */
  countUserActions(userId: ID): Promise<UserActionCounts>;
  upsertAchievement(data: Partial<AchievementRow> & { slug: string; name: string }): Promise<AchievementRow>;
  listAchievements(): Promise<AchievementRow[]>;
  achievementsForUser(userId: ID): Promise<AchievementRow[]>;
  unlockAchievement(userId: ID, achievementId: ID): Promise<boolean>;
  awardXp(input: { userId: ID; amount: number; reason: string; targetKind?: string | null; targetId?: ID | null }): Promise<{ xp: number; level: number; leveledUp: boolean }>;

  notify(input: { userId: ID; kind: string; title: string; body?: string | null; link?: string | null; data?: Record<string, unknown> | null }): Promise<void>;
  listNotifications(userId: ID, page?: Page): Promise<List<NotificationRow>>;
  markNotificationRead(id: number, userId: ID): Promise<boolean>;
  markAllNotificationsRead(userId: ID): Promise<number>;
  unreadNotificationCount(userId: ID): Promise<number>;
}

export interface ContentRepository {
  findPageBySlug(slug: string): Promise<PageRow | null>;
  listPages(filter?: { status?: string; page?: Page }): Promise<List<PageRow>>;
  createPage(data: Partial<PageRow> & { slug: string; title: string }): Promise<PageRow>;
  updatePage(id: ID, patch: Partial<PageRow>): Promise<PageRow | null>;
  deletePage(id: ID, options?: { hard?: boolean }): Promise<boolean>;

  listBlogCategories(): Promise<BlogCategoryRow[]>;
  createBlogCategory(data: Partial<BlogCategoryRow> & { slug: string; name: string }): Promise<BlogCategoryRow>;
  updateBlogCategory(id: ID, patch: Partial<BlogCategoryRow>): Promise<BlogCategoryRow | null>;
  deleteBlogCategory(id: ID): Promise<boolean>;

  listPosts(filter?: { status?: string; categorySlug?: string; tagSlug?: string; q?: string; page?: Page }): Promise<List<BlogPostRow>>;
  findPostBySlug(slug: string): Promise<BlogPostRow | null>;
  createPost(data: Partial<BlogPostRow> & { slug: string; title: string; body: string; authorId: ID }): Promise<BlogPostRow>;
  updatePost(id: ID, patch: Partial<BlogPostRow>): Promise<BlogPostRow | null>;
  deletePost(id: ID, options?: { hard?: boolean }): Promise<boolean>;
  incrementPostViews(id: ID): Promise<void>;
  setPostTags(postId: ID, tags: (string | { slug: string; name: string })[]): Promise<TagRow[]>;
  relatedPosts(postId: ID, limit?: number): Promise<BlogPostRow[]>;
}

export interface CommerceRepository {
  listAds(filter?: { placement?: string; status?: string }): Promise<AdRow[]>;
  /** Live ads for a placement: active, inside its window, ordered by priority. */
  adsForPlacement(placement: string, now?: Date): Promise<AdRow[]>;
  createAd(data: Partial<AdRow> & { name: string; placement: string }): Promise<AdRow>;
  updateAd(id: ID, patch: Partial<AdRow>): Promise<AdRow | null>;
  deleteAd(id: ID): Promise<boolean>;
  trackAd(id: ID, event: 'impression' | 'click'): Promise<void>;

  listPlans(options?: { activeOnly?: boolean }): Promise<PlanRow[]>;
  findPlanBySlug(slug: string): Promise<PlanRow | null>;
  createPlan(data: Partial<PlanRow> & { slug: string; name: string; priceCents: number }): Promise<PlanRow>;
  updatePlan(id: ID, patch: Partial<PlanRow>): Promise<PlanRow | null>;

  activeSubscriptionFor(userId: ID): Promise<SubscriptionRow | null>;
  isPremium(userId: ID | null): Promise<boolean>;
  upsertSubscription(data: Partial<SubscriptionRow> & { userId: ID; planId: ID }): Promise<SubscriptionRow>;
  listSubscriptions(filter?: { status?: string; page?: Page }): Promise<List<SubscriptionRow>>;
  recordPayment(data: Omit<PaymentRow, 'id' | 'createdAt'>): Promise<PaymentRow>;
  findPaymentByProviderId(providerPaymentId: string): Promise<PaymentRow | null>;
  listPayments(userId?: ID, page?: Page): Promise<List<PaymentRow>>;
}

export interface OperationsRepository {
  getSettings(options?: { publicOnly?: boolean }): Promise<SettingRow[]>;
  getSetting(key: string): Promise<SettingRow | null>;
  setSetting(input: { key: string; value: unknown; type?: string; group?: string; isPublic?: boolean; description?: string | null }): Promise<SettingRow>;
  deleteSetting(key: string): Promise<boolean>;

  listSections(page?: string): Promise<SectionRow[]>;
  upsertSection(data: Partial<SectionRow> & { page: string; kind: string }): Promise<SectionRow>;
  reorderSections(page: string, orderedIds: ID[]): Promise<void>;
  deleteSection(id: ID): Promise<boolean>;

  listThemes(): Promise<ThemeRow[]>;
  activeTheme(): Promise<ThemeRow | null>;
  upsertTheme(data: Partial<ThemeRow> & { slug: string; name: string }): Promise<ThemeRow>;
  setDefaultTheme(slug: string): Promise<boolean>;

  findRedirect(sourcePath: string): Promise<RedirectRow | null>;
  listRedirects(page?: Page): Promise<List<RedirectRow>>;
  upsertRedirect(data: { sourcePath: string; targetPath: string; statusCode?: number }): Promise<RedirectRow>;
  deleteRedirect(id: ID): Promise<boolean>;

  logActivity(input: {
    actorId?: ID | null;
    actorLabel?: string | null;
    action: string;
    targetKind?: string | null;
    targetId?: ID | null;
    before?: unknown;
    after?: unknown;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<void>;
  listActivity(filter?: { actorId?: ID; action?: string; page?: Page }): Promise<List<ActivityLogRow>>;

  listProviders(): Promise<ProviderRow[]>;
  findProviderBySlug(slug: string): Promise<ProviderRow | null>;
  upsertProvider(data: Partial<ProviderRow> & { slug: string; name: string }): Promise<ProviderRow>;
  updateProvider(id: ID, patch: Partial<ProviderRow>): Promise<ProviderRow | null>;

  /** Insert-or-ignore by source_hash. `existed` is how duplicate detection is reported. */
  stageProviderItem(input: { providerId: ID; providerGameId: string; sourceHash: string; title?: string | null; payload: Record<string, unknown> }): Promise<{ id: number; existed: boolean }>;
  markProviderItem(id: number, status: string, extra?: { gameId?: ID | null; error?: string | null }): Promise<void>;
  listProviderItems(filter?: { providerId?: ID; status?: string; page?: Page }): Promise<List<ProviderItemRow>>;

  createImportJob(input: { providerId: ID; triggeredBy?: string; actorId?: ID | null }): Promise<ImportJobRow>;
  updateImportJob(id: number, patch: Partial<ImportJobRow>): Promise<void>;
  listImportJobs(filter?: { providerId?: ID; page?: Page }): Promise<List<ImportJobRow>>;

  listReleases(channel?: string): Promise<ReleaseRow[]>;
  latestRelease(channel?: string): Promise<ReleaseRow | null>;
  upsertRelease(data: Partial<ReleaseRow> & { version: string }): Promise<ReleaseRow>;

  createBackup(data: Partial<BackupRow> & { kind: string; trigger?: string }): Promise<BackupRow>;
  updateBackup(id: ID, patch: Partial<BackupRow>): Promise<BackupRow | null>;
  listBackups(page?: Page): Promise<List<BackupRow>>;
}

export type HealthReport = {
  ok: boolean;
  database: { ok: boolean; version?: string; latencyMs?: number; error?: string };
  tables: number;
  migrations: { applied: number; pending: number };
};

/**
 * The whole port. `tx()` hands the callback a `Database` bound to one
 * transaction, so a service can do "insert comment + increment counter + award
 * XP" atomically without any repository knowing about transactions.
 */
export interface Database {
  readonly driver: 'pg' | 'prisma' | 'memory';
  catalog: CatalogRepository;
  social: SocialRepository;
  identity: IdentityRepository;
  engagement: EngagementRepository;
  content: ContentRepository;
  commerce: CommerceRepository;
  operations: OperationsRepository;
  tx<T>(fn: (db: Database) => Promise<T>): Promise<T>;
  health(): Promise<HealthReport>;
  close(): Promise<void>;
}
