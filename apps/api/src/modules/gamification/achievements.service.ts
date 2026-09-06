/**
 * Achievements and XP.
 *
 * WHY A SEPARATE SERVICE: five different features award progress (playing, rating,
 * commenting, favouriting, curating playlists). If each one implemented "check the
 * rules and unlock", the thresholds would drift apart within a week. One service,
 * one rule format, one place to change.
 *
 * THE RULE FORMAT is data, not code: `achievements.rule` holds
 * `{ type: 'plays', threshold: 50 }`. Adding "watch 100 games in the racing
 * category" is a database row, not a deployment — which matters because retention
 * tuning is an operations activity, not an engineering one.
 *
 * COST CONTROL: evaluation happens on a counter metric fetched in ONE query, and
 * only for metrics that could have changed. A play event never triggers five
 * queries, and `unlockAchievement` is `INSERT … ON CONFLICT DO NOTHING`, so a
 * double-clicked "play" button cannot award the badge (or its XP) twice.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AchievementRow, Database, UserActionCounts } from '@voltade/db';
import { XP } from '@voltade/shared';
import { DATABASE } from '../../common/database/database.module.js';

export type AchievementMetric = keyof UserActionCounts;

export type UnlockedAchievement = { slug: string; name: string; tier: string; xp: number; icon: string | null };

export type ProgressResult = {
  /** Badges unlocked by this event (empty most of the time). */
  unlocked: UnlockedAchievement[];
  xpAwarded: number;
  xp: number;
  level: number;
  leveledUp: boolean;
};

const emptyResult: ProgressResult = { unlocked: [], xpAwarded: 0, xp: 0, level: 0, leveledUp: false };

@Injectable()
export class AchievementsService {
  private readonly logger = new Logger('achievements');

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Award XP for an action, then re-evaluate every badge that depends on the
   * metrics that action could have changed.
   *
   * `metrics` is the caller's promise about what moved: a play passes ['plays'],
   * a rating passes ['ratings']. Passing nothing evaluates all five, which is what
   * the nightly reconciliation job does.
   */
  async progress(userId: string, input: { reason: string; amount?: number; metrics?: AchievementMetric[]; targetKind?: string | null; targetId?: string | null }): Promise<ProgressResult> {
    let xpAwarded = 0;
    let xp = 0;
    let level = 0;
    let leveledUp = false;

    const amount = input.amount ?? 0;
    if (amount > 0) {
      const awarded = await this.db.engagement.awardXp({
        userId,
        amount,
        reason: input.reason,
        targetKind: input.targetKind ?? null,
        targetId: input.targetId ?? null,
      });
      xpAwarded = amount;
      xp = awarded.xp;
      level = awarded.level;
      leveledUp = awarded.leveledUp;
    }

    const counts = await this.db.engagement.countUserActions(userId);
    const badges = await this.db.engagement.achievementsForUser(userId);
    const unlocked: UnlockedAchievement[] = [];

    for (const badge of badges) {
      if (badge.unlockedAt) continue;
      const rule = parseRule(badge.rule);
      if (!rule) continue;
      if (input.metrics && input.metrics.length > 0 && !input.metrics.includes(rule.metric)) continue;
      if (counts[rule.metric] < rule.threshold) continue;

      const didUnlock = await this.db.engagement.unlockAchievement(userId, badge.id);
      if (didUnlock) {
        unlocked.push({ slug: badge.slug, name: badge.name, tier: badge.tier, xp: badge.xp, icon: badge.icon });
        xpAwarded += badge.xp;
      }
    }

    if (unlocked.length > 0) {
      // Re-read once at the end rather than after every badge: the level shown to
      // the user is the level they finished this event at.
      const after = await this.db.engagement.countUserActions(userId);
      void after;
      const profile = await this.db.identity.findUserById(userId);
      if (profile) {
        xp = profile.xp;
        level = profile.level;
        leveledUp = leveledUp || level > XP.levelFor(xp - xpAwarded);
      }
      this.logger.debug(`${unlocked.length} badge(s) unlocked for user ${userId}: ${unlocked.map((u) => u.slug).join(', ')}`);
    }

    return { unlocked, xpAwarded, xp, level, leveledUp };
  }

  /** The full badge grid with progress percentages — the profile page's trophy case. */
  async listForUser(userId: string, locale: 'ar' | 'en'): Promise<{ slug: string; name: string; description: string | null; tier: string; xp: number; icon: string | null; hidden: boolean; unlockedAt: string | null; progress: number }[]> {
    const badges: AchievementRow[] = await this.db.engagement.achievementsForUser(userId);
    const counts = await this.db.engagement.countUserActions(userId);
    return badges.map((badge) => {
      const rule = parseRule(badge.rule);
      const current = rule ? counts[rule.metric] : 0;
      const progress = rule && rule.threshold > 0 ? Math.min(100, Math.round((current / rule.threshold) * 100)) : badge.unlockedAt ? 100 : 0;
      const name = locale === 'en' && badge.description ? badge.description : badge.name;
      return {
        slug: badge.slug,
        name,
        description: locale === 'en' ? badge.name : badge.description,
        tier: badge.tier,
        xp: badge.xp,
        icon: badge.icon,
        // Hidden badges show as "???" until earned — spoiling them removes the surprise.
        hidden: badge.isHidden && !badge.unlockedAt,
        unlockedAt: badge.unlockedAt ? badge.unlockedAt.toISOString() : null,
        progress: badge.unlockedAt ? 100 : progress,
      };
    });
  }
}

function parseRule(rule: Record<string, unknown> | null | undefined): { metric: AchievementMetric; threshold: number } | null {
  const type = typeof rule?.type === 'string' ? rule.type : null;
  const threshold = Number(rule?.threshold);
  if (!type || !Number.isFinite(threshold) || threshold <= 0) return null;
  const metrics: AchievementMetric[] = ['plays', 'ratings', 'comments', 'favorites', 'playlists'];
  if (!metrics.includes(type as AchievementMetric)) return null;
  return { metric: type as AchievementMetric, threshold };
}

export { emptyResult as emptyProgressResult };
