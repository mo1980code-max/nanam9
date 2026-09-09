/**
 * Users: self-service profiles, public profiles, the leaderboard and user admin.
 *
 * FIVE DECISIONS SHAPE THIS MODULE:
 *
 * 1. THE PUBLIC IDENTIFIER IS THE USERNAME, NOT THE ID. `/api/users/:username`
 *    mirrors `/u/:username` on the web app, so a shared profile is a readable link
 *    (`voltade.test/u/sara`) instead of an opaque cuid. Ids still work for admin
 *    lookups because staff deal with accounts that may have renamed themselves.
 *
 * 2. PRIVILEGE CHANGES ARE CONSTRAINED BY THE ACTOR'S OWN LEVEL. You cannot edit an
 *    equal or a superior, you cannot grant a role above your own, and only a
 *    super-admin may appoint another super-admin. Without this, any compromised
 *    editor account is one request away from owning the site — and two admins can
 *    lock each other out.
 *
 * 3. NOBODY MAY DEMOTE, BAN OR DELETE THEMSELVES, AND THE LAST ACTIVE SUPER-ADMIN
 *    IS PROTECTED. "I banned myself while testing" and "I demoted the only admin"
 *    are both unrecoverable without database access, which is exactly the failure
 *    the self-update guard in the admin module exists to prevent.
 *
 * 4. BANNING REVOKES SESSIONS. Access tokens are stateless and live for 15 minutes,
 *    so flipping `status` alone would leave an attacker working for a quarter of an
 *    hour. Revoking the session rows is what makes the ban immediate.
 *
 * 5. A PROFILE IS NOT AN ADMIN SURFACE. `UpdateProfileDto` cannot touch email,
 *    status, role or xp. Those live behind `users.update` with their own audit
 *    action, so a mass-assignment bug in the profile form cannot escalate privilege.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database, GamePlayRow, ID, NotificationRow, RoleRow, UserRow } from '@voltade/db';
import { ROLE_LEVELS, XP, safeUrl, sanitizeHtml } from '@voltade/shared';
import { AchievementsService } from '../gamification/achievements.service.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DATABASE } from '../../common/database/database.module.js';
import { AppError, ConflictError } from '../../common/http/errors.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { absoluteUrl } from '../../common/http/urls.js';
import type { RequestUser } from '../../common/decorators/index.js';
import { CONFIG, type AppConfig } from '../../config/env.js';
import type {
  AdminUpdateUserDto,
  BanUserDto,
  HistoryQueryDto,
  LeaderboardQueryDto,
  PublicProfileQueryDto,
  UpdateProfileDto,
  UserListQueryDto,
} from './dto/users.dto.js';

export type LevelProgress = {
  level: number;
  xp: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  /** 0–100, for the profile progress bar. */
  progress: number;
  nextLevelAt: number;
};

export type ProfileView = {
  id: ID;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  website: string | null;
  locale: string;
  timezone: string | null;
  status: string;
  role: { slug: string; name: string; level: number };
  premium: boolean;
  twoFactorEnabled: boolean;
  level: LevelProgress;
  counts: { plays: number; comments: number; favorites: number; playlists: number; badges: number };
  memberSince: string;
  lastLoginAt: string | null;
  url: string;
};

export type PublicProfile = {
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  website: string | null;
  role: { slug: string; name: string } | null;
  level: LevelProgress;
  counts: { plays: number; comments: number; favorites: number; playlists: number; badges: number };
  memberSince: string;
  achievements: { slug: string; name: string; tier: string; icon: string | null; unlockedAt: string | null }[];
  playlists: { slug: string; name: string; gamesCount: number; url: string }[];
  url: string;
  /** Absolute, for share buttons and the ProfilePage JSON-LD. */
  shareUrl: string | null;
};

export type AdminUserView = ProfileView & {
  email: string | null;
  emailVerifiedAt: string | null;
  lastLoginIp: string | null;
  permissions: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type LeaderboardEntry = {
  rank: number;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  level: number;
  xp: number;
  plays: number;
  url: string;
};

@Injectable()
export class UsersService {
  private readonly logger = new Logger('users');

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly achievements: AchievementsService,
  ) {}

  // ── self service ─────────────────────────────────────────────────────────

  async myProfile(user: RequestUser): Promise<ProfileView & { email: string | null }> {
    const row = await this.mustFindUser(user.id);
    const view = await this.profileView(row);
    // The owner sees their own email; nobody else ever does.
    return { ...view, email: row.email };
  }

  async updateProfile(meta: RequestMeta, user: RequestUser, dto: UpdateProfileDto): Promise<ProfileView> {
    const row = await this.mustFindUser(user.id);
    const patch: Partial<UserRow> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    const track = (field: keyof UserRow, value: unknown): void => {
      before[field] = row[field] ?? null;
      after[field] = value;
      (patch as Record<string, unknown>)[field] = value;
    };

    if (dto.displayName !== undefined) track('displayName', cleanText(dto.displayName));
    if (dto.bio !== undefined) track('bio', cleanText(dto.bio));
    if (dto.locale !== undefined) track('locale', dto.locale);
    if (dto.timezone !== undefined) track('timezone', cleanText(dto.timezone));
    if (dto.avatarUrl !== undefined) track('avatarUrl', this.assertAvatar(dto.avatarUrl));
    if (dto.website !== undefined) track('website', this.assertWebsite(dto.website));

    if (Object.keys(patch).length === 0) {
      throw new AppError('profile.no_changes', 'nothing to update', 400);
    }

    const updated = await this.db.identity.updateUser(row.id, patch);
    if (!updated) throw new AppError('user.not_found', `no user with id ${row.id}`, 404);

    this.audit.recordChange(meta, { action: 'user.profile_update', targetKind: 'user', targetId: row.id, before, after });
    return this.profileView(updated);
  }

  /** XP, level progress and the five counters achievement rules are evaluated on. */
  /**
   * XP, level progress and the five counters achievement rules are evaluated on.
   *
   * A GET that only reads: the daily-login bonus is awarded by the auth module, so
   * a profile refresh can never grant XP twice.
   */
  async myStats(user: RequestUser): Promise<{ level: LevelProgress; counts: Record<string, number>; premium: boolean; badges: { unlocked: number; total: number } }> {
    const row = await this.mustFindUser(user.id);
    const [counts, badges] = await Promise.all([
      this.db.engagement.countUserActions(row.id),
      this.db.engagement.achievementsForUser(row.id),
    ]);
    return {
      level: levelProgress(row.xp),
      counts,
      premium: user.premium,
      badges: { unlocked: badges.filter((b) => b.unlockedAt).length, total: badges.length },
    };
  }

  async myAchievements(user: RequestUser) {
    return this.achievements.listForUser(user.id, user.locale === 'en' ? 'en' : 'ar');
  }

  async myHistory(query: HistoryQueryDto, user: RequestUser): Promise<{ items: HistoryEntry[]; total: number }> {
    // `gameId` is what the repository filters on, so a slug has to be resolved first.
    let gameId: ID | null = null;
    if (query.game) {
      const game = await this.db.catalog.findGameBySlug(query.game);
      gameId = game?.id ?? query.game;
    }
    const result = await this.db.engagement.playHistory({ userId: user.id, gameId, page: query.pageArg });
    return { items: result.items.map(historyEntry), total: result.total };
  }

  async myNotifications(pageArg: { page: number; perPage: number; offset: number }, user: RequestUser): Promise<{ items: NotificationView[]; total: number; unread: number }> {
    const [result, unread] = await Promise.all([
      this.db.engagement.listNotifications(user.id, pageArg),
      this.db.engagement.unreadNotificationCount(user.id),
    ]);
    return { items: result.items.map(notificationView), total: result.total, unread };
  }

  /** Ownership is enforced here, not in SQL, so a wrong id is a 404 and not a silent no-op. */
  async markNotificationRead(id: number, user: RequestUser): Promise<{ read: boolean }> {
    const ok = await this.db.engagement.markNotificationRead(id, user.id);
    if (!ok) throw new AppError('notification.not_found', `no notification with id ${id}`, 404);
    return { read: true };
  }

  async markAllNotificationsRead(user: RequestUser): Promise<{ read: number }> {
    return { read: await this.db.engagement.markAllNotificationsRead(user.id) };
  }

  // ── public ───────────────────────────────────────────────────────────────

  /**
   * A public profile. Banned and deleted accounts 404 rather than rendering an empty
   * page: a profile that exists but shows nothing is a support ticket, and a banned
   * user's page should not keep ranking in search.
   */
  async publicProfile(username: string, query: PublicProfileQueryDto = {}): Promise<PublicProfile> {
    const row = await this.db.identity.findUserByUsername(username);
    if (!row || row.deletedAt || row.status === 'banned' || row.status === 'deleted') {
      throw new AppError('user.not_found', `no public profile for "${username}"`, 404);
    }

    const wantsPlaylists = query.playlists !== '0' && query.playlists !== 'false';
    const [counts, badges, playlists, favorites] = await Promise.all([
      this.db.engagement.countUserActions(row.id),
      this.db.engagement.achievementsForUser(row.id),
      wantsPlaylists ? this.db.social.listPlaylists(row.id) : Promise.resolve([]),
      // One row, no items: only `total` is needed, and a profile page must not
      // download somebody's whole favourites list to print a number.
      this.db.social.listFavorites(row.id, { page: 1, perPage: 1, offset: 0 }),
    ]);

    const unlocked = badges.filter((b) => b.unlockedAt && !b.isHidden);
    const publicPlaylists = playlists.filter((p) => p.visibility === 'public');
    const role = row.role ?? null;
    const isStaff = role ? role.level >= 40 : false;

    return {
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      bio: row.bio,
      website: row.website,
      // A moderator badge is public information and builds trust in the comments
      // section; the exact role level is not.
      role: isStaff && role ? { slug: role.slug, name: role.name } : null,
      level: levelProgress(row.xp),
      counts: {
        plays: counts.plays,
        comments: counts.comments,
        favorites: favorites.total,
        playlists: publicPlaylists.length,
        badges: unlocked.length,
      },
      memberSince: isoOf(row.createdAt),
      achievements: unlocked.map((b) => ({ slug: b.slug, name: b.name, tier: b.tier, icon: b.icon, unlockedAt: iso(b.unlockedAt) })),
      playlists: publicPlaylists.map((p) => ({ slug: p.slug, name: p.name, gamesCount: p.gamesCount, url: `/playlist/${p.slug}` })),
      url: `/u/${row.username}`,
      shareUrl: absoluteUrl(`/u/${row.username}`, this.config.APP_URL),
    };
  }

  async leaderboard(query: LeaderboardQueryDto): Promise<{ items: LeaderboardEntry[]; total: number; metric: string }> {
    const metric = query.metric ?? 'xp';
    const result = await this.db.identity.listUsers({
      status: 'active',
      sort: metric,
      page: query.pageArg,
    });
    const firstRank = (query.pageArg.page - 1) * query.pageArg.perPage + 1;
    return {
      metric,
      total: result.total,
      items: result.items.map((row, index) => ({
        rank: firstRank + index,
        username: row.username,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
        level: row.level,
        xp: row.xp,
        plays: row.playsCount,
        url: `/u/${row.username}`,
      })),
    };
  }

  // ── admin ────────────────────────────────────────────────────────────────

  async adminList(query: UserListQueryDto): Promise<{ items: AdminUserView[]; total: number }> {
    const result = await this.db.identity.listUsers({
      q: query.q,
      status: query.status,
      roleSlug: query.role,
      sort: query.sort,
      page: query.pageArg,
    });
    const items = await Promise.all(result.items.map((row) => this.adminView(row)));
    return { items, total: result.total };
  }

  /** `ref` is an id or a username: staff paste both into the search box. */
  async adminOne(ref: string): Promise<AdminUserView> {
    return this.adminView(await this.findByRef(ref));
  }

  async adminUpdate(meta: RequestMeta, actor: RequestUser, ref: string, dto: AdminUpdateUserDto): Promise<AdminUserView> {
    const target = await this.findByRef(ref);
    this.assertCanManage(actor, target);

    const patch: Partial<UserRow> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const track = (field: keyof UserRow, value: unknown): void => {
      before[field] = (target as Record<string, unknown>)[field] ?? null;
      after[field] = value;
      (patch as Record<string, unknown>)[field] = value;
    };

    if (dto.displayName !== undefined) track('displayName', cleanText(dto.displayName));
    if (dto.bio !== undefined) track('bio', cleanText(dto.bio));
    if (dto.email !== undefined) {
      const email = dto.email.trim().toLowerCase();
      const existing = await this.db.identity.findUserByEmail(email);
      // Checked before the write: a unique-index violation surfacing as a 500 tells
      // the admin nothing about which field to fix.
      if (existing && existing.id !== target.id) {
        throw new ConflictError('user.email_taken', `another account already uses ${email}`, { email: ['already in use'] });
      }
      track('email', email);
    }
    if (dto.status !== undefined) {
      if (dto.status !== target.status) await this.assertStatusChangeAllowed(target, dto.status);
      track('status', dto.status);
    }
    if (dto.role !== undefined) {
      const role = await this.db.identity.findRoleBySlug(dto.role);
      if (!role) throw new AppError('role.not_found', `no role with the slug "${dto.role}"`, 404);
      this.assertCanGrant(actor, target, role);
      track('roleId', role.id);
      after.role = role.slug;
    }
    if (dto.xp !== undefined) {
      track('xp', dto.xp);
      track('level', XP.levelFor(dto.xp));
    }

    if (Object.keys(patch).length === 0 && dto.revokeSessions !== true) {
      throw new AppError('user.no_changes', 'nothing to update', 400);
    }

    const updated = Object.keys(patch).length > 0 ? await this.db.identity.updateUser(target.id, patch) : target;
    if (!updated) throw new AppError('user.not_found', `no user with id ${target.id}`, 404);

    let revokedSessions = 0;
    if (dto.revokeSessions === true) {
      revokedSessions = await this.db.identity.revokeSessionsForUser(target.id);
      after.revokedSessions = revokedSessions;
    }

    this.audit.recordChange(meta, { action: 'user.admin_update', targetKind: 'user', targetId: target.id, before, after });
    this.logger.log(`${actor.username} updated ${target.username}${revokedSessions ? ` (revoked ${revokedSessions} session(s))` : ''}`);
    return this.adminView(updated);
  }

  async ban(meta: RequestMeta, actor: RequestUser, ref: string, dto: BanUserDto = {}): Promise<{ banned: boolean; revokedSessions: number; username: string }> {
    const target = await this.findByRef(ref);
    this.assertCanManage(actor, target);
    await this.assertNotLastSuperAdmin(target, 'ban');

    if (target.status === 'banned') return { banned: true, revokedSessions: 0, username: target.username };

    await this.db.identity.updateUser(target.id, { status: 'banned' });
    const revokedSessions = await this.db.identity.revokeSessionsForUser(target.id);
    this.audit.recordChange(meta, {
      action: 'user.ban',
      targetKind: 'user',
      targetId: target.id,
      before: { status: target.status },
      after: { status: 'banned', reason: dto.reason ?? null, revokedSessions },
    });
    this.logger.warn(`${actor.username} banned ${target.username}: ${dto.reason ?? 'no reason given'}`);
    return { banned: true, revokedSessions, username: target.username };
  }

  async unban(meta: RequestMeta, actor: RequestUser, ref: string): Promise<{ banned: boolean; username: string }> {
    const target = await this.findByRef(ref);
    this.assertCanManage(actor, target);
    if (target.status !== 'banned') return { banned: false, username: target.username };

    // Restoring to `active`, never to `pending`: a ban is not a registration state,
    // and un-banning into `pending` would leave the account unable to sign in.
    await this.db.identity.updateUser(target.id, { status: 'active', deletedAt: null });
    this.audit.recordChange(meta, { action: 'user.unban', targetKind: 'user', targetId: target.id, before: { status: 'banned' }, after: { status: 'active' } });
    return { banned: false, username: target.username };
  }

  /** Soft delete. Comments, ratings and playlists stay attributed to the account. */
  async softDelete(meta: RequestMeta, actor: RequestUser, ref: string): Promise<{ deleted: boolean; revokedSessions: number }> {
    const target = await this.findByRef(ref);
    this.assertCanManage(actor, target);
    await this.assertNotLastSuperAdmin(target, 'delete');

    const deleted = await this.db.identity.deleteUser(target.id);
    const revokedSessions = deleted ? await this.db.identity.revokeSessionsForUser(target.id) : 0;
    if (deleted) {
      this.audit.record(meta, { action: 'user.delete', targetKind: 'user', targetId: target.id, after: { revokedSessions } });
      this.logger.warn(`${actor.username} deleted ${target.username}`);
    }
    return { deleted, revokedSessions };
  }

  /** Roles with their effective permissions — the admin user form's role picker. */
  async roles(): Promise<{ items: { slug: string; name: string; level: number; permissions: string[] }[]; total: number }> {
    const roles: RoleRow[] = await this.db.identity.listRoles();
    const items = await Promise.all(
      roles.map(async (role) => ({
        slug: role.slug,
        name: role.name,
        level: role.level,
        permissions: await this.db.identity.permissionsForRoleIds([role.id]),
      })),
    );
    items.sort((a, b) => b.level - a.level);
    return { items, total: items.length };
  }

  // ── guards ───────────────────────────────────────────────────────────────

  private assertCanManage(actor: RequestUser, target: UserRow): void {
    if (actor.id === target.id) {
      throw new AppError('user.self_modification', 'you cannot change your own role or status through the admin API', 403);
    }
    const actorLevel = actor.role?.level ?? 0;
    const targetLevel = target.role?.level ?? ROLE_LEVELS.user;
    // Upward edits are always out of reach, and below the top of the hierarchy a
    // peer is out of reach too: an editor cannot demote another editor.
    //
    // At the very top the rule has to be different, because assertCanGrant lets a
    // super admin appoint another super admin. If appointing is allowed but
    // demoting is not, that second super admin becomes permanent — nobody can
    // change their role, ban them or delete them short of editing the database.
    // The last working super admin is still protected by assertNotLastSuperAdmin,
    // so allowing lateral edits here cannot lock anybody out of the panel.
    const topOfHierarchy = ROLE_LEVELS['super-admin'];
    const lateralBelowTheTop = targetLevel === actorLevel && actorLevel < topOfHierarchy;
    if (targetLevel > actorLevel || lateralBelowTheTop) {
      throw new AppError('auth.forbidden', 'you can only manage accounts below your own role', 403);
    }
  }

  private assertCanGrant(actor: RequestUser, target: UserRow, role: RoleRow): void {
    const actorLevel = actor.role?.level ?? 0;
    if (role.level > actorLevel) {
      throw new AppError('auth.forbidden', `you cannot grant a role above your own (${role.slug})`, 403);
    }
    // Appointing an equal is the one escalation that is sometimes legitimate — and
    // it is exactly the one that must be limited to the top of the hierarchy.
    if (role.level === actorLevel && actorLevel < ROLE_LEVELS['super-admin']) {
      throw new AppError('auth.forbidden', 'only a super admin may appoint another super admin', 403);
    }
    if (target.role?.slug === 'super-admin' && role.slug !== 'super-admin') {
      void this.assertNotLastSuperAdmin(target, 'demote');
    }
  }

  private async assertStatusChangeAllowed(target: UserRow, status: string): Promise<void> {
    if (status === 'banned' || status === 'deleted') {
      await this.assertNotLastSuperAdmin(target, status);
    }
  }

  /** Refuses to remove the site's last working super admin. */
  private async assertNotLastSuperAdmin(target: UserRow, action: string): Promise<void> {
    if (target.role?.slug !== 'super-admin') return;
    const peers = await this.db.identity.listUsers({
      roleSlug: 'super-admin',
      status: 'active',
      page: { page: 1, perPage: 2, offset: 0 },
    });
    if (peers.total <= 1) {
      throw new ConflictError(
        'user.last_admin',
        `cannot ${action} the only active super admin — promote another one first`,
      );
    }
  }

  // ── lookups and mapping ──────────────────────────────────────────────────

  private async findByRef(ref: string): Promise<UserRow> {
    const byId = await this.db.identity.findUserById(ref, true);
    if (byId) return byId;
    const byName = await this.db.identity.findUserByUsername(ref);
    if (byName) return byName;
    throw new AppError('user.not_found', `no user matching "${ref}"`, 404);
  }

  private async mustFindUser(id: ID): Promise<UserRow> {
    const row = await this.db.identity.findUserById(id, true);
    if (!row || row.deletedAt) throw new AppError('user.not_found', 'account no longer exists', 404);
    return row;
  }

  private async profileView(row: UserRow): Promise<ProfileView> {
    const [counts, favorites, playlists, badges, premium] = await Promise.all([
      this.db.engagement.countUserActions(row.id),
      this.db.social.listFavorites(row.id, { page: 1, perPage: 1, offset: 0 }),
      this.db.social.listPlaylists(row.id),
      this.db.engagement.achievementsForUser(row.id),
      // `premium` is an optional join on UserRow, so it is resolved rather than
      // trusted: a profile that says "premium" for a lapsed subscription is a
      // support conversation.
      this.db.commerce.isPremium(row.id),
    ]);
    const role = row.role ?? { slug: 'user', name: 'User', level: 20 };
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      bio: row.bio,
      website: row.website,
      locale: row.locale,
      timezone: row.timezone,
      status: row.status,
      role: { slug: role.slug, name: role.name, level: role.level },
      premium,
      twoFactorEnabled: row.twoFactorEnabled,
      level: levelProgress(row.xp),
      counts: {
        plays: counts.plays,
        comments: counts.comments,
        favorites: favorites.total,
        playlists: playlists.length,
        badges: badges.filter((b) => b.unlockedAt).length,
      },
      memberSince: isoOf(row.createdAt),
      lastLoginAt: iso(row.lastLoginAt),
      url: `/u/${row.username}`,
    };
  }

  private async adminView(row: UserRow): Promise<AdminUserView> {
    const base = await this.profileView(row);
    const permissions = await this.db.identity.permissionsForRoleIds([row.roleId]);
    return {
      ...base,
      email: row.email,
      emailVerifiedAt: iso(row.emailVerifiedAt),
      // Abuse-handling data: it is here because a moderator investigating a spam
      // wave needs it, it is behind `users.view`, and reading it is a privileged act.
      lastLoginIp: row.lastLoginIp,
      permissions,
      createdAt: isoOf(row.createdAt),
      updatedAt: isoOf(row.updatedAt),
      deletedAt: iso(row.deletedAt),
    };
  }

  /** An avatar must live on this site or on an https URL — never a `javascript:` URI
   *  that ends up inside `<img src>` on somebody's profile. */
  private assertAvatar(value: string): string | null {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (trimmed.startsWith('/')) return trimmed;
    const url = safeUrl(trimmed, 'img', 'src');
    if (!url) throw new AppError('profile.invalid_avatar', 'avatar must be a site path or an http(s) URL', 400);
    return url;
  }

  private assertWebsite(value: string): string | null {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = safeUrl(withScheme, 'a', 'href');
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new AppError('profile.invalid_website', 'website must be an http(s) URL', 400);
    }
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
    } catch {
      throw new AppError('profile.invalid_website', 'website must be an http(s) URL', 400);
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Profile text is plain text. Sanitising first (which drops `<script>` *content*)
 * and then removing the remaining tags means `<b>hi</b>` → `hi` and
 * `<script>alert(1)</script>` → `` instead of leaving the payload behind as prose.
 */
function cleanText(value: string): string {
  return sanitizeHtml(value, { maxLength: 2000 }).replace(/<[^>]*>/g, '').trim();
}

export function levelProgress(xp: number): LevelProgress {
  const total = Math.max(0, Math.floor(xp));
  const level = XP.levelFor(total);
  // level L starts at ((L-1)^2)*100 XP, so the curve is quadratic and each level
  // costs more than the last: level 2 at 100, level 10 at 8100.
  const base = (level - 1) ** 2 * 100;
  const nextLevelAt = level ** 2 * 100;
  const span = Math.max(1, nextLevelAt - base);
  const into = Math.max(0, Math.min(span, total - base));
  return {
    level,
    xp: total,
    xpIntoLevel: into,
    xpForNextLevel: span,
    progress: Math.round((into / span) * 100),
    nextLevelAt,
  };
}

export type HistoryEntry = {
  id: number;
  game: { id: string; slug: string; title: string; thumbnailUrl: string } | null;
  device: string;
  durationMs: number | null;
  completed: boolean;
  startedAt: string;
  url: string | null;
};

function historyEntry(row: GamePlayRow): HistoryEntry {
  return {
    id: row.id,
    game: row.game ?? null,
    device: row.device,
    durationMs: row.durationMs,
    completed: row.completed,
    startedAt: isoOf(row.startedAt),
    url: row.game ? `/game/${row.game.slug}` : null,
  };
}

export type NotificationView = {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
};

function notificationView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    link: row.link,
    read: row.readAt !== null,
    createdAt: isoOf(row.createdAt),
  };
}

/** For NOT NULL columns: keeps the payload type honest without a `!` at each call site. */
function isoOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
