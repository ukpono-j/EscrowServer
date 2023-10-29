import { formatDistanceToNow } from 'date-fns';

// export function formatCreatedAt(createdAt) {
//   return formatDistanceToNow(new Date(createdAt), { addSuffix: true });
// }

export function formatCreatedAt(createdAt) {
  try {
    return formatDistanceToNow(new Date(createdAt), { addSuffix: true });
  } catch (error) {
    console.error("Error formatting createdAt:", error);
    return "Invalid Date"; // or handle it in a way suitable for your application
  }
}
