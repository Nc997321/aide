import { invoke } from "@tauri-apps/api/core";
import type {
  CustomizationType,
  CustomizationItem,
} from "../types/customization";

// ── Unified Customization API ──

export const customizationApi = {
  // List all items of a type
  async list(type: CustomizationType): Promise<CustomizationItem[]> {
    return invoke(`list_${type}s`);
  },

  // Get a single item
  async get(type: CustomizationType, id: string): Promise<CustomizationItem> {
    return invoke(`get_${type}`, { id });
  },

  // Create a new item
  async create(type: CustomizationType, data: Partial<CustomizationItem>): Promise<CustomizationItem> {
    return invoke(`create_${type}`, { data });
  },

  // Update an existing item
  async update(type: CustomizationType, id: string, data: Partial<CustomizationItem>): Promise<void> {
    return invoke(`update_${type}`, { id, data });
  },

  // Delete an item
  async delete(type: CustomizationType, id: string): Promise<void> {
    return invoke(`delete_${type}`, { id });
  },

  // Toggle enabled state
  async toggle(type: CustomizationType, id: string, enabled: boolean): Promise<void> {
    return invoke(`toggle_${type}`, { id, enabled });
  },
};

// ── Type-specific API (for backward compatibility) ──

export const agentApi = {
  list: () => customizationApi.list('agent'),
  get: (id: string) => customizationApi.get('agent', id),
  create: (data: Partial<CustomizationItem>) => customizationApi.create('agent', data),
  update: (id: string, data: Partial<CustomizationItem>) => customizationApi.update('agent', id, data),
  delete: (id: string) => customizationApi.delete('agent', id),
};

export const skillApi = {
  list: () => customizationApi.list('skill'),
  get: (id: string) => customizationApi.get('skill', id),
  create: (data: Partial<CustomizationItem>) => customizationApi.create('skill', data),
  update: (id: string, data: Partial<CustomizationItem>) => customizationApi.update('skill', id, data),
  delete: (id: string) => customizationApi.delete('skill', id),
};

export const instructionApi = {
  getGlobal: () => invoke<CustomizationItem>("get_global_instructions"),
  saveGlobal: (content: string) => invoke("save_global_instructions", { content }),
  getProject: () => invoke<CustomizationItem>("get_project_instructions"),
  saveProject: (content: string) => invoke("save_project_instructions", { content }),
};

export const hookApi = {
  list: () => customizationApi.list('hook'),
  get: (id: string) => customizationApi.get('hook', id),
  create: (data: Partial<CustomizationItem>) => customizationApi.create('hook', data),
  update: (id: string, data: Partial<CustomizationItem>) => customizationApi.update('hook', id, data),
  delete: (id: string) => customizationApi.delete('hook', id),
};

export const mcpServerApi = {
  list: () => customizationApi.list('mcp_server'),
  get: (id: string) => customizationApi.get('mcp_server', id),
  create: (data: Partial<CustomizationItem>) => customizationApi.create('mcp_server', data),
  update: (id: string, data: Partial<CustomizationItem>) => customizationApi.update('mcp_server', id, data),
  delete: (id: string) => customizationApi.delete('mcp_server', id),
};
