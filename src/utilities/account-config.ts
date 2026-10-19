import type { SidebarConfig } from '../types';
import type { Connection } from 'home-assistant-js-websocket';

// Home Assistant resolves the user from the authenticated connection. Never send
// a user ID supplied by a file or persist this value in shared browser storage.
export const ACCOUNT_CONFIG_KEY = 'sidebar_organizer';
export type AccountConfigResult =
  | { status: 'absent' }
  | { status: 'ready'; config: SidebarConfig }
  | { status: 'unavailable' };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

export function validateAccountConfig(value: unknown): SidebarConfig {
  if (!object(value)) throw new Error('Configuration must be an object.');
  for (const key of [
    'hide_header_toggle',
    'animation_off',
    'accordion_mode',
    'move_settings_from_fixed',
    'force_transparent_background',
    'scroll_hide_header',
  ]) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
  }
  for (const key of ['header_title', 'text_transformation']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`${key} must be text.`);
  }
  if (value.animation_delay !== undefined && typeof value.animation_delay !== 'number')
    throw new Error('Invalid animation_delay.');
  if (value.width !== undefined && typeof value.width !== 'number' && typeof value.width !== 'string')
    throw new Error('Invalid width.');
  if (
    value.uncategorized_items !== undefined &&
    typeof value.uncategorized_items !== 'boolean' &&
    !strings(value.uncategorized_items)
  ) {
    throw new Error('Invalid uncategorized_items.');
  }
  for (const key of ['custom_groups', 'bottom_groups']) {
    if (value[key] !== undefined && (!object(value[key]) || !Object.values(value[key]).every(strings))) {
      throw new Error(`${key} must map group names to lists of panel paths.`);
    }
  }
  for (const key of ['bottom_items', 'bottom_grid_items', 'hidden_items', 'default_collapsed']) {
    if (value[key] !== undefined && !strings(value[key])) throw new Error(`${key} must be a list of strings.`);
  }
  if (value.new_items !== undefined && (!Array.isArray(value.new_items) || !value.new_items.every(object))) {
    throw new Error('new_items must be a list of objects.');
  }
  for (const item of (value.new_items || []) as Record<string, unknown>[]) {
    for (const key of ['title', 'icon', 'url_path', 'target', 'entity', 'group', 'icon_template']) {
      if (item[key] !== undefined && item[key] !== null && typeof item[key] !== 'string') {
        throw new Error(`Invalid new item ${key}.`);
      }
    }
    for (const key of ['tap_action', 'hold_action', 'double_tap_action']) {
      if (item[key] !== undefined && !object(item[key])) throw new Error(`Invalid new item ${key}.`);
    }
  }
  for (const key of ['color_config', 'notification', 'pinned_groups', 'visibility_templates']) {
    if (value[key] !== undefined && !object(value[key])) throw new Error(`${key} must be an object.`);
  }
  if (object(value.visibility_templates)) {
    for (const map of Object.values(value.visibility_templates)) {
      if (!object(map) || !Object.values(map).every((item) => typeof item === 'string'))
        throw new Error('Invalid visibility templates.');
    }
  }
  if (object(value.notification) && !Object.values(value.notification).every((item) => typeof item === 'string')) {
    throw new Error('Invalid notification templates.');
  }
  if (
    object(value.pinned_groups) &&
    !Object.values(value.pinned_groups).every(
      (item) => item === true || (object(item) && (item.icon === undefined || typeof item.icon === 'string'))
    )
  ) {
    throw new Error('Invalid pinned groups.');
  }
  if (object(value.color_config)) {
    for (const key of ['light', 'dark', 'custom_theme']) {
      if (value.color_config[key] !== undefined && !object(value.color_config[key]))
        throw new Error('Invalid color configuration.');
    }
    for (const key of ['light', 'dark']) {
      for (const [name, setting] of Object.entries(value.color_config[key] || {})) {
        if (name === 'custom_styles') {
          if (!object(setting) || !Object.values(setting).every((entry) => typeof entry === 'string')) {
            throw new Error('Invalid custom styles.');
          }
        } else if (typeof setting !== 'string') throw new Error('Invalid color value.');
      }
    }
  }
  return structuredClone(value) as SidebarConfig;
}

export async function loadAccountConfig(connection: Connection): Promise<AccountConfigResult> {
  // Only an explicit missing record enables legacy loading. A failed read or an
  // unknown schema must not resurrect an old layout cached by this browser.
  try {
    const { value } = await connection.sendMessagePromise<{ value: unknown }>({
      type: 'frontend/get_user_data',
      key: ACCOUNT_CONFIG_KEY,
    });
    if (value === null) return { status: 'absent' };
    if (!object(value) || value.version !== 1) return { status: 'unavailable' };
    return { status: 'ready', config: validateAccountConfig(value.config) };
  } catch {
    return { status: 'unavailable' };
  }
}

export async function saveAccountConfig(connection: Connection, config: SidebarConfig | null): Promise<void> {
  // Write only our namespaced key; null opts out without touching native sidebar
  // preferences or any other user's record. The server supplies the user scope.
  const value = config === null ? null : { version: 1, config: validateAccountConfig(config) };
  await connection.sendMessagePromise({ type: 'frontend/set_user_data', key: ACCOUNT_CONFIG_KEY, value });
}
