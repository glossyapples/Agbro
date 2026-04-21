// Auth.js v5 catch-all route.
import { handlers } from '@/lib/auth/config';

export const runtime = 'nodejs';
export const { GET, POST } = handlers;
