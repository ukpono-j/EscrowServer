import { formatDistanceToNow } from 'date-fns';

export function formatCreatedAt(createdAt) {
  return formatDistanceToNow(new Date(createdAt), { addSuffix: true });
}
