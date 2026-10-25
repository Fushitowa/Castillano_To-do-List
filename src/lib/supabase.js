import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anonKey);
export const supabase = supabaseConfigured ? createClient(url, anonKey) : null;

export function taskFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    done: row.done,
    createdAt: new Date(row.created_at).getTime(),
    dueAt: row.due_at ?? '',
    reminded: row.reminded,
    notes: row.notes,
    color: row.color ?? '',
  };
}

export function taskToRow(task, userId) {
  return {
    id: task.id,
    user_id: userId,
    title: task.title,
    done: task.done,
    created_at: new Date(task.createdAt).toISOString(),
    due_at: task.dueAt ? new Date(task.dueAt).toISOString() : null,
    reminded: task.reminded,
    notes: task.notes,
    color: task.color || null,
  };
}
