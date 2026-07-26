const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DB_LIFETIME_DAYS = 30;
const AUTO_EXPORT_LEAD_DAYS = 3;

function getCreatedAtMs(db) {
  const value =
    db?.createdAt ||
    db?.created_at ||
    db?.created ||
    db?.createdTime ||
    db?.created_time;
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function getExpiryStatus(db, now = Date.now()) {
  const createdAtMs = getCreatedAtMs(db);
  if (!createdAtMs) {
    return {
      known: false,
      createdAt: null,
      expiresAt: null,
      daysRemaining: null,
      hoursRemaining: null,
      nearExpiry: false,
      expired: false,
    };
  }

  const expiresAtMs = createdAtMs + DB_LIFETIME_DAYS * DAY_MS;
  const remainingMs = expiresAtMs - now;
  const daysRemaining = remainingMs / DAY_MS;
  const hoursRemaining = remainingMs / HOUR_MS;

  return {
    known: true,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    daysRemaining,
    hoursRemaining,
    nearExpiry: daysRemaining <= AUTO_EXPORT_LEAD_DAYS && daysRemaining > 0,
    expired: remainingMs <= 0,
  };
}

module.exports = {
  HOUR_MS,
  DAY_MS,
  DB_LIFETIME_DAYS,
  AUTO_EXPORT_LEAD_DAYS,
  getCreatedAtMs,
  getExpiryStatus,
};
