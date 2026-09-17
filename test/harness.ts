import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/bg/index.ts";

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

interface RegisteredTool {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: Record<string, unknown>,
  ) => Promise<ToolResult>;
}

export interface Notification {
  message: { customType?: string; content: string; display?: boolean };
  options: { deliverAs?: string; triggerTurn?: boolean } | undefined;
  afterShutdown: boolean;
}

export function createHarness(defaults: { cwd?: string; hasUI?: boolean; mode?: string } = {}) {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const notifications: Notification[] = [];
  let shutDown = false;

  const pi = {
    registerTool(tool: RegisteredTool & { name: string }) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(
      message: Notification["message"],
      options?: Notification["options"],
    ) {
      notifications.push({ message, options, afterShutdown: shutDown });
    },
  };

  extension(pi as unknown as ExtensionAPI);

  const baseContext = {
    cwd: defaults.cwd ?? process.cwd(),
    hasUI: defaults.hasUI ?? true,
    mode: defaults.mode ?? "tui",
  };

  return {
    notifications,
    async execute(
      name: string,
      params: Record<string, unknown> = {},
      options: {
        signal?: AbortSignal;
        cwd?: string;
        hasUI?: boolean;
        mode?: string;
      } = {},
    ): Promise<ToolResult> {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool.execute(
        `test-${name}`,
        params,
        options.signal,
        undefined,
        {
          ...baseContext,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.hasUI === undefined ? {} : { hasUI: options.hasUI }),
          ...(options.mode === undefined ? {} : { mode: options.mode }),
        },
      );
    },
    async shutdown(reason = "reload") {
      if (shutDown) return;
      shutDown = true;
      for (const handler of handlers.get("session_shutdown") ?? []) {
        await handler({ reason }, baseContext);
      }
    },
  };
}

export function resultText(result: ToolResult): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
