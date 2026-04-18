import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  backgroundProcessOutputTool,
  clearAllBackgroundProcesses,
  killAllBackgroundProcesses,
  listBackgroundProcessesTool,
  sendProcessInputTool,
  spawnBackgroundProcessTool,
  stopBackgroundProcessTool,
} from "./background_processes";
import type { ToolContext } from "./registry";

// Mock context for testing
function createMockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    chatId: 1,
    channel: "test",
    workingDir: "/tmp",
    db: {
      query: () => ({
        get: () => ({ external_chat_id: "test-chat-123" }),
      }),
    } as any,
    config: {} as any,
    ...overrides,
  };
}

describe("Background Process Tools", () => {
  beforeEach(() => {
    // Clear all processes before each test for isolation
    clearAllBackgroundProcesses();
  });

  afterEach(() => {
    // Clean up any running processes after each test
    killAllBackgroundProcesses();
  });

  describe("spawn_background_process", () => {
    test("spawns a simple process", async () => {
      const ctx = createMockContext();
      const result = await spawnBackgroundProcessTool.execute(
        {
          command: "sleep",
          args: ["0.1"],
          name: "test-sleep",
        },
        ctx,
      );

      expect(result.isError).toBeFalsy();
      expect(result.output).toContain("Started background process");
      expect(result.output).toContain("test-sleep");
      expect(result.metadata?.processId).toBeGreaterThan(0);
    });

    test("blocks dangerous commands", async () => {
      const ctx = createMockContext();
      const result = await spawnBackgroundProcessTool.execute(
        {
          command: "rm",
          args: ["-rf", "/"],
        },
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Blocked");
    });

    test("handles non-existent command", async () => {
      const ctx = createMockContext();
      const result = await spawnBackgroundProcessTool.execute(
        {
          command: "nonexistent-command-12345",
        },
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Failed to spawn");
    });
  });

  describe("background_process_output", () => {
    test("returns error for non-existent process", async () => {
      const result = await backgroundProcessOutputTool.execute(
        { id: 99999 },
        createMockContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("No process found");
    });

    test("returns output from running process", async () => {
      const ctx = createMockContext();

      // Spawn a process that produces output
      const spawnResult = await spawnBackgroundProcessTool.execute(
        {
          command: "echo",
          args: ["hello", "world"],
          name: "echo-test",
        },
        ctx,
      );
      const processId = spawnResult.metadata?.processId;

      // Wait a bit for output to be captured
      await new Promise((r) => setTimeout(r, 100));

      const result = await backgroundProcessOutputTool.execute(
        { id: processId, lines: 10 },
        ctx,
      );

      expect(result.isError).toBeFalsy();
      expect(result.output).toContain("echo-test");
    });
  });

  describe("list_background_processes", () => {
    test("returns empty list when no processes", async () => {
      const ctx = createMockContext();
      const result = await listBackgroundProcessesTool.execute({}, ctx);

      expect(result.output).toContain("No background processes found");
    });

    test("lists spawned processes", async () => {
      const ctx = createMockContext();

      // Spawn a process
      await spawnBackgroundProcessTool.execute(
        {
          command: "sleep",
          args: ["10"],
          name: "list-test",
        },
        ctx,
      );

      const result = await listBackgroundProcessesTool.execute({}, ctx);

      expect(result.output).toContain("list-test");
      expect(result.output).toContain("running");
    });
  });

  describe("stop_background_process", () => {
    test("returns error for non-existent process", async () => {
      const result = await stopBackgroundProcessTool.execute(
        { id: 99999 },
        createMockContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("No process found");
    });

    test("stops a running process", async () => {
      const ctx = createMockContext();

      // Spawn a long-running process
      const spawnResult = await spawnBackgroundProcessTool.execute(
        {
          command: "sleep",
          args: ["60"],
          name: "stop-test",
        },
        ctx,
      );
      const processId = spawnResult.metadata?.processId;

      // Stop it
      const result = await stopBackgroundProcessTool.execute(
        { id: processId },
        ctx,
      );

      expect(result.isError).toBeFalsy();
      expect(result.output).toContain("SIGTERM");
    });
  });

  describe("send_process_input", () => {
    test("returns error for non-existent process", async () => {
      const result = await sendProcessInputTool.execute(
        { id: 99999, input: "test" },
        createMockContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("No process found");
    });

    test("returns error for stopped process", async () => {
      const ctx = createMockContext();

      // Spawn and immediately stop a process
      const spawnResult = await spawnBackgroundProcessTool.execute(
        { command: "echo", args: ["done"] },
        ctx,
      );
      const processId = spawnResult.metadata?.processId;

      // Wait for it to finish
      await new Promise((r) => setTimeout(r, 100));

      const result = await sendProcessInputTool.execute(
        { id: processId, input: "test" },
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("not running");
    });
  });
});

describe("Security", () => {
  beforeEach(() => {
    clearAllBackgroundProcesses();
  });

  afterEach(() => {
    killAllBackgroundProcesses();
  });

  test("scrubs secrets from output buffer", async () => {
    const ctx = createMockContext();

    // Spawn a process that echoes a fake secret
    const result = await spawnBackgroundProcessTool.execute(
      {
        command: "echo",
        args: ["secret:sk-abcdefghij1234567890abcdefghij"],
      },
      ctx,
    );
    const processId = result.metadata?.processId;

    // Wait for output
    await new Promise((r) => setTimeout(r, 100));

    const outputResult = await backgroundProcessOutputTool.execute(
      { id: processId },
      ctx,
    );

    // The output buffer (recent lines section) should have the secret redacted
    expect(outputResult.output).toContain("[REDACTED]");
    // The "Recent output" section should not contain the raw secret
    const recentOutputSection =
      outputResult.output.split("--- Recent output")[1] || "";
    expect(recentOutputSection).not.toContain("sk-abcdefghij");
  });
});
