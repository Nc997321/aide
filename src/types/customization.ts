// ── Customization Types ──

export type CustomizationType = 'agent' | 'skill' | 'instruction' | 'hook' | 'mcp_server';

export interface CustomizationItem {
  id: string;
  name: string;
  type: CustomizationType;
  enabled: boolean;
  path: string;
  description?: string;
  metadata?: Record<string, any>;
}

// ── Agent Types ──

export interface Agent extends CustomizationItem {
  type: 'agent';
  description: string;
  model: string;
  tools: string[];
  content: string;
}

// ── Skill Types ──

export interface Skill extends CustomizationItem {
  type: 'skill';
  description: string;
  context?: string;
  scripts: string[];
}

// ── Instruction Types ──

export interface Instruction extends CustomizationItem {
  type: 'instruction';
  content: string;
  is_global: boolean;
}

// ── Hook Types ──

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop';

export interface Hook extends CustomizationItem {
  type: 'hook';
  event: HookEvent;
  matcher: string;
  command: string;
  timeout?: number;
  asyncRewake?: boolean;
}

// ── MCP Server Types ──

export interface McpServer extends CustomizationItem {
  type: 'mcp_server';
  command: string;
  args: string[];
  env: Record<string, string>;
}

// ── Form Types ──

export interface CustomizationFormData {
  agent?: Partial<Agent>;
  skill?: Partial<Skill>;
  instruction?: Partial<Instruction>;
  hook?: Partial<Hook>;
  mcp_server?: Partial<McpServer>;
}

// ── Category Config ──

export interface CustomizationCategory {
  type: CustomizationType;
  label: string;
  icon: string;
  description: string;
}
