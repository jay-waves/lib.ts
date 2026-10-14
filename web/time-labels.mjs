// Shared elapsed-time calculation for file metadata and browsing history.
function timeSince(value, now) {
  const elapsed = Math.max(0, now - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  return { minutes, hours, days };
}

export function formatRelativeModified(value, now = Date.now()) {
  const { minutes, hours, days } = timeSince(value, now);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return months === 1 ? 'last month' : `${months} months ago`;
  const years = Math.floor(days / 365.25);
  return years === 1 ? 'last year' : `${years} years ago`;
}

export const HISTORY_GROUPS = [
  { id: 'past-week', name: 'Past Week' },
  { id: 'past-month', name: 'Past Month' },
  { id: 'past-six-months', name: 'Past 6 Months' },
  { id: 'older', name: 'Older' },
];

export function historyTimeGroup(value, now = Date.now()) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return null;
  const { days } = timeSince(value, now);
  return days < 7 ? 'past-week' : days < 30 ? 'past-month' : days < 183 ? 'past-six-months' : 'older';
}
