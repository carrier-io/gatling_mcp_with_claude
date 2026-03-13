#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, exec } from "child_process";
import { promisify } from "util";
import { homedir } from "os";
import { readFile, writeFile, stat, readdir } from "fs/promises";
import { EventEmitter } from "events";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { glob } from "glob";

const execAsync = promisify(exec);

// Enhanced Task Manager with streaming capabilities
class StreamingTaskManager extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map();
    this.taskHistory = new Map();
    this.maxHistorySize = 100;
  }

  createTask(taskId, taskInfo) {
    const task = {
      id: taskId,
      ...taskInfo,
      status: 'pending',
      startTime: Date.now(),
      progress: 0,
      steps: [],
      currentStep: null,
      outputStream: [],
      errorStream: [],
      isStreaming: true,
      process: null,
      lastActivity: Date.now()
    };
    
    this.tasks.set(taskId, task);
    this.emit('taskCreated', task);
    return task;
  }

  updateTask(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (task) {
      Object.assign(task, updates);
      task.lastActivity = Date.now();
      this.emit('taskUpdated', task);
    }
    return task;
  }

  appendOutput(taskId, output, isError = false) {
    const task = this.tasks.get(taskId);
    if (task) {
      const timestamp = Date.now();
      const logEntry = {
        timestamp,
        content: output,
        type: isError ? 'error' : 'output'
      };
      
      if (isError) {
        task.errorStream.push(logEntry);
      } else {
        task.outputStream.push(logEntry);
      }
      
      task.lastActivity = timestamp;
      this.emit('taskOutput', { taskId, output, isError, timestamp });
    }
  }

  completeTask(taskId, result) {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'completed';
      task.endTime = Date.now();
      task.result = result;
      task.duration = task.endTime - task.startTime;
      task.progress = 100;
      
      // Move to history with size limit
      this.taskHistory.set(taskId, task);
      if (this.taskHistory.size > this.maxHistorySize) {
        const oldestKey = this.taskHistory.keys().next().value;
        this.taskHistory.delete(oldestKey);
      }
      
      this.tasks.delete(taskId);
      this.emit('taskCompleted', task);
    }
    return task;
  }

  failTask(taskId, error) {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'failed';
      task.endTime = Date.now();
      task.error = error.message;
      task.duration = task.endTime - task.startTime;
      
      // Move to history
      this.taskHistory.set(taskId, task);
      if (this.taskHistory.size > this.maxHistorySize) {
        const oldestKey = this.taskHistory.keys().next().value;
        this.taskHistory.delete(oldestKey);
      }
      
      this.tasks.delete(taskId);
      this.emit('taskFailed', task);
    }
    return task;
  }

  getTask(taskId) {
    return this.tasks.get(taskId) || this.taskHistory.get(taskId);
  }

  getAllTasks() {
    return Array.from(this.tasks.values());
  }

  getTaskHistory() {
    return Array.from(this.taskHistory.values());
  }

  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (task) {
      try {
        if (task.process) {
          task.process.kill('SIGTERM');
        }
        task.status = 'cancelled';
        task.endTime = Date.now();
        task.duration = task.endTime - task.startTime;
        
        this.taskHistory.set(taskId, task);
        this.tasks.delete(taskId);
        
        this.emit('taskCancelled', task);
      } catch (error) {
        console.error(`[DEBUG] Error cancelling task ${taskId}: ${error.message}`);
        // Still mark as cancelled even if process kill fails
        task.status = 'cancelled';
        task.endTime = Date.now();
        task.duration = task.endTime - task.startTime;
        
        this.taskHistory.set(taskId, task);
        this.tasks.delete(taskId);
      }
    }
    return task;
  }

  getStreamingOutput(taskId, fromTimestamp = 0) {
    const task = this.getTask(taskId);
    if (!task) return null;
    
    return {
      output: task.outputStream.filter(entry => entry.timestamp > fromTimestamp),
      error: task.errorStream.filter(entry => entry.timestamp > fromTimestamp),
      status: task.status,
      progress: task.progress,
      currentStep: task.currentStep,
      lastActivity: task.lastActivity
    };
  }
}

class LocalMCPServer {
  constructor() {
    try {
      this.taskManager = new StreamingTaskManager();
      this.server = new Server(
        {
          name: "mcp-local",
          version: "1.0.0",
        },
        {
          capabilities: {
            tools: {},
          },
        }
      );

      this.setupToolHandlers();
      this.setupTaskCleanup();
    } catch (error) {
      console.error('[DEBUG] Error in LocalMCPServer constructor:', error);
      throw error;
    }
  }

  setupTaskCleanup() {
    // Clean up old tasks every 5 minutes
    setInterval(() => {
      try {
        const now = Date.now();
        const maxAge = 30 * 60 * 1000; // 30 minutes
        
        // Collect stale task IDs first to avoid modifying Map during iteration
        const staleTaskIds = [];
        for (const [taskId, task] of this.taskManager.tasks) {
          if (now - task.lastActivity > maxAge) {
            staleTaskIds.push(taskId);
          }
        }
        
        // Clean up stale tasks
        for (const taskId of staleTaskIds) {
          console.error(`[DEBUG] Cleaning up stale task: ${taskId}`);
          this.taskManager.cancelTask(taskId);
        }
        
        if (staleTaskIds.length > 0) {
          console.error(`[DEBUG] Cleaned up ${staleTaskIds.length} stale tasks`);
        }
      } catch (error) {
        console.error(`[DEBUG] Error during task cleanup: ${error.message}`);
      }
    }, 5 * 60 * 1000);
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      console.error("[DEBUG] ListToolsRequestSchema handler called");
      const tools = [
        {
          name: "execute_python_script",
          description: "Execute a Python script with optional arguments. Simple tool to run Python files directly.",
          inputSchema: {
            type: "object",
            properties: {
              scriptPath: {
                type: "string",
                description: "Path to the Python script to execute (required)",
              },
              workingDirectory: {
                type: "string",
                description: "Working directory to run the script from (optional, defaults to script's directory)",
              },
              arguments: {
                type: "string",
                description: "Command line arguments to pass to the script (optional)",
                default: "",
              },
              pythonExecutable: {
                type: "string",
                description: "Python executable to use (optional, defaults to 'python3')",
                default: "python3",
              },
              timeout: {
                type: "number",
                description: "Timeout in seconds (optional, defaults to 30)",
                default: 30,
              },
            },
            required: ["scriptPath"],
          },
        },
        {
          name: "execute_gatling_simulation",
          description: "Run a Gatling simulation using Maven. Specify simulation class and optional -D parameters.",
          inputSchema: {
            type: "object",
            properties: {
              simulationClass: {
                type: "string",
                description: "Fully qualified Gatling simulation class (e.g. epam.tests.SwaggerSimulation)",
              },
              workingDirectory: {
                type: "string",
                description: "Directory to run Maven from (optional, defaults to workspace root)",
              },
              mavenExecutable: {
                type: "string",
                description: "Maven executable to use (optional, defaults to 'mvn')",
                default: "mvn",
              },
              gatlingParams: {
                type: "string",
                description: "Additional -D parameters for Gatling (optional, e.g. -Dusers=100 -Dduration=60)",
                default: "",
              },
              timeout: {
                type: "number",
                description: "Timeout in seconds (optional, defaults to 120)",
                default: 120,
              },
            },
            required: ["simulationClass"],
          },
        },
        {
          name: "git_clone",
          description: "Clone a git repository by URL and checkout a specific branch. Optionally specify target directory.",
          inputSchema: {
            type: "object",
            properties: {
              repoUrl: {
                type: "string",
                description: "Git repository URL (required)",
              },
              branch: {
                type: "string",
                description: "Branch to checkout (optional, defaults to 'main')",
                default: "main",
              },
              targetDirectory: {
                type: "string",
                description: "Target directory to clone into (optional, defaults to repo name)",
                default: "",
              },
            },
            required: ["repoUrl"],
          },
        },
        {
          name: "git_pull",
          description: "Pull the latest changes from the remote repository in the specified working directory.",
          inputSchema: {
            type: "object",
            properties: {
              workingDirectory: {
                type: "string",
                description: "Directory of the git repository to pull (required)",
              },
            },
            required: ["workingDirectory"],
          },
        },
        {
          name: "get_errors",
          description: "Parse and group errors from Gatling simulation error log. Provide working directory (default: /opt/gatling).",
          inputSchema: {
            type: "object",
            properties: {
              workingDirectory: {
                type: "string",
                description: "Directory where Gatling results are stored (default: /opt/gatling)",
                default: "/opt/gatling",
              },
            },
            required: [],
          },
        },
        {
          name: "claude_code",
          description: "Execute Claude CLI with --permission-mode bypassPermissions and a user prompt. Optionally specify working directory.",
          inputSchema: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description: "Prompt to execute with Claude (required)",
              },
              workingDirectory: {
                type: "string",
                description: "Directory to run Claude from (optional)",
                default: "",
              },
            },
            required: ["prompt"],
          },
        },
        {
          name: "git_commit_and_push",
          description: "Add all changed files (except target/), commit with a message, and push to the current branch in the repo.",
          inputSchema: {
            type: "object",
            properties: {
              workingDirectory: {
                type: "string",
                description: "Directory of the git repository (required)",
              },
              commitMessage: {
                type: "string",
                description: "Commit message (optional, defaults to 'commit fixes by codex')",
                default: "commit fixes by codex",
              },
            },
            required: ["workingDirectory"],
          },
        }
      ];
      console.error(`[DEBUG] Returning ${tools.length} tool`);
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        switch (name) {
          case "execute_python_script":
            return await this.handleExecutePythonScript(args);
          case "execute_gatling_simulation":
            return await this.handleExecuteGatlingSimulation(args);
          case "git_clone":
            return await this.handleGitClone(args);
          case "git_pull":
            return await this.handleGitPull(args);
          case "get_errors":
            return await this.handleGetErrors(args);
          case "claude_code":
            return await this.handleClaudeCode(args);
          case "git_commit_and_push":
            return await this.handleGitCommitAndPush(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        console.error(`[DEBUG] Error in tool handler ${name}:`, error);
        return {
          content: [
            {
              type: "text",
              text: `❌ **Error executing ${name}:**\n\n${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async handleExecutePythonScript(args) {
    const {
      scriptPath,
      workingDirectory,
      arguments: scriptArgs = "",
      pythonExecutable = "python3",
      timeout = 30000,
    } = args;

    try {
      // Validate script path
      if (!scriptPath) {
        throw new Error("Script path is required");
      }

      // Determine working directory
      const workDir = workingDirectory || path.dirname(path.resolve(scriptPath));
      const absoluteScriptPath = path.resolve(scriptPath);

      // Check if script exists
      if (!fs.existsSync(absoluteScriptPath)) {
        throw new Error(`Python script not found: ${absoluteScriptPath}`);
      }

      // Build command
      const args_array = [absoluteScriptPath];
      if (scriptArgs && scriptArgs.trim()) {
        // Split arguments and add them
        const parsedArgs = scriptArgs.trim().split(/\s+/);
        args_array.push(...parsedArgs);
      }

      const command = `${pythonExecutable} ${args_array.join(' ')}`;
      
      console.error(`[DEBUG] Executing Python script: ${command}`);
      console.error(`[DEBUG] Working directory: ${workDir}`);
      
      const { stdout, stderr } = await execAsync(command, { 
        cwd: workDir,
        timeout: timeout
      });
      
      const output = stdout + stderr;
      
      let resultText = `🐍 **Python Script Execution Complete**\n\n`;
      resultText += `**Script:** ${absoluteScriptPath}\n`;
      resultText += `**Working Directory:** ${workDir}\n`;
      resultText += `**Python Executable:** ${pythonExecutable}\n`;
      if (scriptArgs) resultText += `**Arguments:** ${scriptArgs}\n`;
      resultText += `**Timeout:** ${timeout}ms\n\n`;
      
      if (output.trim()) {
        resultText += `**Output:**\n\`\`\`\n${output.trim()}\n\`\`\`\n\n`;
      } else {
        resultText += `**Output:** (no output)\n\n`;
      }
      
      resultText += `✅ **Python script executed successfully**`;
      
      return {
        content: [{
          type: "text",
          text: resultText,
        }],
        isError: false,
      };
      
    } catch (error) {
      let errorText = `❌ **Python Script Execution Failed**\n\n`;
      errorText += `**Script:** ${scriptPath}\n`;
      errorText += `**Working Directory:** ${workingDirectory || 'default'}\n`;
      errorText += `**Python Executable:** ${pythonExecutable}\n`;
      if (scriptArgs) errorText += `**Arguments:** ${scriptArgs}\n`;
      errorText += `**Error:** ${error.message}\n\n`;
      
      if (error.stderr) {
        errorText += `**Details:**\n\`\`\`\n${error.stderr}\n\`\`\``;
      }
      
      return {
        content: [{
          type: "text",
          text: errorText,
        }],
        isError: true,
      };
    }
  }
  
  async loadShellEnvironment() {
    let envVars = {};
    
    try {
      const { stdout } = await execAsync('zsh -l -c "source ~/.zshrc 2>/dev/null; env"', { timeout: 5000 });
      
      stdout.split('\n').forEach(line => {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
          const [, key, value] = match;
          envVars[key] = value;
        }
      });
      
      const apiKeyCount = Object.keys(envVars).filter(key => key.includes('API_KEY')).length;
      console.error(`[DEBUG] Loaded ${apiKeyCount} API keys from shell environment`);
      
      return { ...process.env, ...envVars };
    } catch (error) {
      console.error(`[DEBUG] Failed to load shell environment: ${error.message}`);
      return process.env;
    }
  }

  async executeCodexStreaming(taskId, options) {
    const { command, workingDirectory, additionalArgs = "" } = options;
    
    try {
      // Update task status
      this.taskManager.updateTask(taskId, { status: 'running' });
      
      // Load environment
      const env = await this.loadShellEnvironment();
      
      // Build codex arguments
      const codexArgs = ["exec", command];
      if (additionalArgs) {
        const parsedArgs = additionalArgs.trim().split(/\s+/);
        codexArgs.push(...parsedArgs);
      }

      console.error(`[DEBUG] Starting streaming execution for task ${taskId}: codex ${codexArgs.join(' ')}`);
      
      // Start process
      const codexProcess = spawn("codex", codexArgs, {
        cwd: workingDirectory || process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: env,
      });

      // Store process reference
      this.taskManager.updateTask(taskId, { process: codexProcess });

      // Handle stdout
      codexProcess.stdout.on("data", (data) => {
        const output = data.toString();
        this.taskManager.appendOutput(taskId, output, false);
        
        // Update progress based on output patterns
        this.updateProgressFromOutput(taskId, output);
      });

      // Handle stderr
      codexProcess.stderr.on("data", (data) => {
        const error = data.toString();
        this.taskManager.appendOutput(taskId, error, true);
      });

      // Handle process completion
      codexProcess.on("close", (code) => {
        console.error(`[DEBUG] Task ${taskId} completed with code ${code}`);
        
        if (code === 0) {
          this.taskManager.completeTask(taskId, "Process completed successfully");
        } else {
          this.taskManager.failTask(taskId, new Error(`Process exited with code ${code}`));
        }
      });

      // Handle process errors
      codexProcess.on("error", (error) => {
        console.error(`[DEBUG] Task ${taskId} error:`, error);
        this.taskManager.failTask(taskId, error);
      });

      // Close stdin
      codexProcess.stdin.end();
      
    } catch (error) {
      console.error(`[DEBUG] Failed to start streaming execution:`, error);
      this.taskManager.failTask(taskId, error);
    }
  }

  updateProgressFromOutput(taskId, output) {
    const task = this.taskManager.getTask(taskId);
    if (!task) return;

    let progress = task.progress;
    let currentStep = task.currentStep;

    // Simple progress estimation based on output patterns
    if (output.includes('Starting')) {
      progress = Math.max(progress, 10);
      currentStep = 'Starting execution';
    } else if (output.includes('Analyzing') || output.includes('Reading')) {
      progress = Math.max(progress, 20);
      currentStep = 'Analyzing codebase';
    } else if (output.includes('Generating') || output.includes('Creating')) {
      progress = Math.max(progress, 40);
      currentStep = 'Generating code';
    } else if (output.includes('Writing') || output.includes('Saving')) {
      progress = Math.max(progress, 70);
      currentStep = 'Writing files';
    } else if (output.includes('Testing') || output.includes('Validating')) {
      progress = Math.max(progress, 85);
      currentStep = 'Testing and validation';
    } else if (output.includes('Complete') || output.includes('Done')) {
      progress = 95;
      currentStep = 'Finalizing';
    }

    if (progress > task.progress || currentStep !== task.currentStep) {
      this.taskManager.updateTask(taskId, { progress, currentStep });
    }
  }

  async executeNpmTest(taskId, options) {
    const { workingDirectory, testScript = "test", additionalArgs = "" } = options;
    
    try {
      // Update task status
      this.taskManager.updateTask(taskId, { status: 'running' });
      
      // Build npm command
      const npmArgs = ["run", testScript];
      if (additionalArgs && additionalArgs.trim()) {
        // Split additional args and add them
        const parsedArgs = additionalArgs.trim().split(/\s+/);
        npmArgs.push("--", ...parsedArgs);
      }

      console.error(`[DEBUG] Starting npm test execution for task ${taskId}: npm ${npmArgs.join(' ')}`);
      
      // Start npm process
      const npmProcess = spawn("npm", npmArgs, {
        cwd: workingDirectory || process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      // Store process reference
      this.taskManager.updateTask(taskId, { process: npmProcess });

      // Handle stdout
      npmProcess.stdout.on("data", (data) => {
        const output = data.toString();
        this.taskManager.appendOutput(taskId, output, false);
        
        // Update progress based on npm test output patterns
        this.updateNpmTestProgressFromOutput(taskId, output);
      });

      // Handle stderr
      npmProcess.stderr.on("data", (data) => {
        const error = data.toString();
        this.taskManager.appendOutput(taskId, error, true);
      });

      // Handle process completion
      npmProcess.on("close", (code) => {
        console.error(`[DEBUG] NPM test task ${taskId} completed with code ${code}`);
        
        if (code === 0) {
          this.taskManager.completeTask(taskId, "NPM test completed successfully");
        } else {
          this.taskManager.failTask(taskId, new Error(`NPM test failed with exit code ${code}`));
        }
      });

      // Handle process errors
      npmProcess.on("error", (error) => {
        console.error(`[DEBUG] NPM test task ${taskId} error:`, error);
        this.taskManager.failTask(taskId, error);
      });

      // Close stdin
      npmProcess.stdin.end();
      
    } catch (error) {
      console.error(`[DEBUG] Failed to start npm test execution:`, error);
      this.taskManager.failTask(taskId, error);
    }
  }

  // Git branch management methods
  async handleGitBranchInfo(args) {
    const { 
      workingDirectory = process.cwd(),
      includeRemote = true,
      showCommitInfo = true
    } = args;
    
    try {
      const result = await this.getGitBranchInfo(workingDirectory, {
        includeRemote,
        showCommitInfo
      });
      
      return {
        content: [{
          type: "text",
          text: result,
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ **Error getting branch info:** ${error.message}`,
        }],
        isError: true,
      };
    }
  }

  async handleGitSwitchBranch(args) {
    const {
      workingDirectory = process.cwd(),
      branch,
    } = args;

    try {
      // Validate git repository
      if (!fs.existsSync(path.join(workingDirectory, '.git'))) {
        throw new Error(`Not a git repository: ${workingDirectory}`);
      }

      // Simple branch switch (no creation)
      const gitCommand = `git checkout ${branch}`;
      
      console.error(`[DEBUG] Executing git switch: ${gitCommand}`);
      
      const { stdout, stderr } = await execAsync(gitCommand, { 
        cwd: workingDirectory,
        timeout: 15000 // 15 second timeout
      });
      
      const output = stdout + stderr;
      
      let resultText = `🌿 **Git Branch Switch Complete**\n\n`;
      resultText += `**Working Directory:** ${workingDirectory}\n`;
      resultText += `**Target Branch:** ${branch}\n\n`;
      
      if (output.trim()) {
        resultText += `**Output:**\n\`\`\`\n${output.trim()}\n\`\`\`\n\n`;
      }
      
      // Get current branch to confirm switch
      try {
        const { stdout: currentBranch } = await execAsync('git branch --show-current', { 
          cwd: workingDirectory 
        });
        resultText += `✅ **Successfully switched to branch:** ${currentBranch.trim()}`;
      } catch (error) {
        resultText += `✅ **Branch switch completed**`;
      }
      
      return {
        content: [{
          type: "text",
          text: resultText,
        }],
        isError: false,
      };
      
    } catch (error) {
      let errorText = `❌ **Git Branch Switch Failed**\n\n`;
      errorText += `**Working Directory:** ${workingDirectory}\n`;
      errorText += `**Target Branch:** ${branch}\n`;
      errorText += `**Error:** ${error.message}\n\n`;
      
      if (error.stderr) {
        errorText += `**Details:**\n\`\`\`\n${error.stderr}\n\`\`\``;
      }
      
      return {
        content: [{
          type: "text",
          text: errorText,
        }],
        isError: true,
      };
    }
  }

  async getGitBranchInfo(workingDirectory, options = {}) {
    const { includeRemote, showCommitInfo } = options;
    
    let resultText = `🌿 **Git Branch Information**\n\n`;
    resultText += `**Repository:** ${workingDirectory}\n\n`;
    
    try {
      // Validate git repository
      if (!fs.existsSync(path.join(workingDirectory, '.git'))) {
        throw new Error(`Not a git repository: ${workingDirectory}`);
      }

      // Get current branch
      try {
        const { stdout: currentBranch } = await execAsync('git branch --show-current', { cwd: workingDirectory });
        resultText += `**Current Branch:** ${currentBranch.trim()}\n\n`;
      } catch (error) {
        resultText += `**Current Branch:** Unable to determine\n\n`;
      }

      // Get local branches
      try {
        const { stdout: localBranches } = await execAsync('git branch', { cwd: workingDirectory });
        const branches = localBranches.split('\n')
          .map(line => line.replace(/^\*?\s*/, '').trim())
          .filter(line => line && !line.startsWith('('));
        
        resultText += `**Local Branches (${branches.length}):**\n`;
        
        for (const branch of branches) {
          if (!branch) continue;
          
          let branchLine = `- ${branch}`;
          
          if (showCommitInfo) {
            try {
              const { stdout: commitInfo } = await execAsync(`git log -1 --format="%h %s (%ar)" ${branch}`, { cwd: workingDirectory });
              branchLine += ` - ${commitInfo.trim()}`;
            } catch (error) {
              // Skip commit info if error
            }
          }
          
          resultText += branchLine + '\n';
        }
        resultText += '\n';
      } catch (error) {
        resultText += `**Local Branches:** Error getting branches: ${error.message}\n\n`;
      }

      // Get remote branches if requested
      if (includeRemote) {
        try {
          const { stdout: remoteBranches } = await execAsync('git branch -r', { cwd: workingDirectory });
          const branches = remoteBranches.split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.includes('->'));
          
          resultText += `**Remote Branches (${branches.length}):**\n`;
          
          for (const branch of branches) {
            if (!branch) continue;
            
            let branchLine = `- ${branch}`;
            
            if (showCommitInfo) {
              try {
                const { stdout: commitInfo } = await execAsync(`git log -1 --format="%h %s (%ar)" ${branch}`, { cwd: workingDirectory });
                branchLine += ` - ${commitInfo.trim()}`;
              } catch (error) {
                // Skip commit info if error
              }
            }
            
            resultText += branchLine + '\n';
          }
          resultText += '\n';
        } catch (error) {
          resultText += `**Remote Branches:** Error getting remote branches: ${error.message}\n\n`;
        }
      }

      // Get recent branch activity
      try {
        const { stdout: recentBranches } = await execAsync('git for-each-ref --sort=-committerdate refs/heads/ --format="%(refname:short) - %(committerdate:relative) - %(subject)" --count=5', { cwd: workingDirectory });
        
        if (recentBranches.trim()) {
          resultText += `**Recent Activity (Last 5 branches):**\n`;
          recentBranches.split('\n').forEach(line => {
            if (line.trim()) {
              resultText += `- ${line.trim()}\n`;
            }
          });
        }
      } catch (error) {
        resultText += `**Recent Activity:** Error getting recent branches: ${error.message}\n`;
      }
      
      return resultText;
    } catch (error) {
      throw new Error(`Failed to get git branch info: ${error.message}`);
    }
  }

  async run() {
    console.error("[DEBUG] Starting Local MCP server with file system tools...");
    const transport = new StdioServerTransport();
    console.error("[DEBUG] Transport created");
    await this.server.connect(transport);
    console.error("[DEBUG] Server connected - Local MCP server running on stdio");
  }

  // Missing helper methods
  updateNpmTestProgressFromOutput(taskId, output) {
    const task = this.taskManager.getTask(taskId);
    if (!task) return;

    let progress = task.progress;
    let currentStep = task.currentStep;

    // Progress estimation based on npm test output patterns
    if (output.includes('> ') && output.includes('@') && output.includes('test')) {
      progress = Math.max(progress, 10);
      currentStep = 'Starting test suite';
    } else if (output.includes('PASS') || output.includes('✓')) {
      progress = Math.max(progress, 30);
      currentStep = 'Running tests';
    } else if (output.includes('FAIL') || output.includes('✗')) {
      progress = Math.max(progress, 50);
      currentStep = 'Test failures detected';
    } else if (output.includes('Test Suites:') || output.includes('Tests:')) {
      progress = Math.max(progress, 80);
      currentStep = 'Collecting test results';
    } else if (output.includes('Coverage') || output.includes('%')) {
      progress = Math.max(progress, 90);
      currentStep = 'Generating coverage report';
    } else if (output.includes('Done in') || output.includes('Ran all test suites')) {
      progress = 95;
      currentStep = 'Finalizing test results';
    }

    if (progress > task.progress || currentStep !== task.currentStep) {
      this.taskManager.updateTask(taskId, { progress, currentStep });
    }
  }

  formatTaskResult(task) {
    let responseText = `🤖 **Codex Execution Complete**\n\n`;
    responseText += `**Task:** ${task.name}\n`;
    responseText += `**Status:** ${task.status.toUpperCase()}\n`;
    responseText += `**Duration:** ${Math.round(task.duration / 1000)}s\n\n`;
    
    if (task.status === 'completed') {
      responseText += `✅ **Task completed successfully!**\n\n`;
    } else if (task.status === 'failed') {
      responseText += `❌ **Task failed:** ${task.error}\n\n`;
    }
    
    // Include recent output
    const recentOutput = [...task.outputStream, ...task.errorStream]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-20);
    
    if (recentOutput.length > 0) {
      responseText += `**Output:**\n\`\`\`\n`;
      recentOutput.forEach(entry => {
        responseText += `${entry.content}\n`;
      });
      responseText += `\`\`\`\n`;
    }
    
    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
    };
  }

  generateTaskId() {
    return uuidv4();
  }

  formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  async buildFileTree(targetPath, maxDepth = 3, includeHidden = false, currentDepth = 0, options = {}) {
    if (currentDepth >= maxDepth) {
      return '';
    }

    const { fileTypes = [], excludePatterns = [] } = options;

    try {
      const stats = await fs.promises.stat(targetPath);
      if (!stats.isDirectory()) {
        return path.basename(targetPath);
      }

      const items = await fs.promises.readdir(targetPath);
      let filteredItems = includeHidden 
        ? items 
        : items.filter(item => !item.startsWith('.'));

      // Apply exclude patterns
      if (excludePatterns.length > 0) {
        filteredItems = filteredItems.filter(item => {
          return !excludePatterns.some(pattern => {
            if (pattern.includes('*')) {
              const regex = new RegExp(pattern.replace(/\*/g, '.*'));
              return regex.test(item);
            }
            return item.includes(pattern);
          });
        });
      }

      let result = '';
      const indent = '  '.repeat(currentDepth);

      for (let i = 0; i < filteredItems.length; i++) {
        const item = filteredItems[i];
        const itemPath = path.join(targetPath, item);
        const isLast = i === filteredItems.length - 1;
        const prefix = isLast ? '└── ' : '├── ';

        try {
          const itemStats = await fs.promises.stat(itemPath);
          if (itemStats.isDirectory()) {
            result += `${indent}${prefix}📁 ${item}/\n`;
            if (currentDepth + 1 < maxDepth) {
              const subtree = await this.buildFileTree(itemPath, maxDepth, includeHidden, currentDepth + 1, options);
              if (subtree) {
                result += subtree;
              }
            }
          } else {
            // Apply file type filtering
            if (fileTypes.length > 0) {
              const ext = path.extname(item).slice(1); // Remove the dot
              if (!fileTypes.includes(ext)) {
                continue; // Skip this file
              }
            }
            
            const size = this.formatFileSize(itemStats.size);
            result += `${indent}${prefix}📄 ${item} (${size})\n`;
          }
        } catch (error) {
          result += `${indent}${prefix}❌ ${item} (access denied)\n`;
        }
      }

      return result;
    } catch (error) {
      throw new Error(`Cannot access path ${targetPath}: ${error.message}`);
    }
  }

  // File exploration and content handlers
  async handleExploreDirectory(args) {
    try {
      const { 
        directoryPath = process.cwd(), 
        fileTypes = "",
        excludePatterns = "",
        includeHidden = false 
      } = args;

      // Parse comma-separated parameters into arrays
      const fileTypesArray = this.parseArrayParameter(fileTypes);
      const excludePatternsArray = this.parseArrayParameter(excludePatterns);

      const stats = await fs.promises.stat(directoryPath);
      if (!stats.isDirectory()) {
        return {
          content: [{
            type: "text",
            text: `❌ **Error:** ${directoryPath} is not a directory`,
          }],
          isError: true,
        };
      }

      const items = await fs.promises.readdir(directoryPath);
      const filteredItems = includeHidden 
        ? items 
        : items.filter(item => !item.startsWith('.'));

      let result = `📁 **Directory: ${directoryPath}**\n\n`;
      
      for (const item of filteredItems) {
        const itemPath = path.join(directoryPath, item);
        try {
          const itemStats = await fs.promises.stat(itemPath);
          if (itemStats.isDirectory()) {
            result += `📁 ${item}/\n`;
          } else {
            const size = this.formatFileSize(itemStats.size);
            result += `📄 ${item} (${size})\n`;
          }
        } catch (error) {
          result += `❌ ${item} (access denied)\n`;
        }
      }

      return {
        content: [{
          type: "text",
          text: result,
        }],
        isError: false,
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ **Error exploring directory:** ${error.message}`,
        }],
        isError: true,
      };
    }
  }

  async handleSearchFiles(args) {
    try {
      const { 
        pattern, 
        searchPath = process.cwd(), 
        fileTypes = "",
        excludePatterns = "",
        includeHidden = false,
        maxResults = 100
      } = args;

      // Parse comma-separated parameters into arrays
      const fileTypesArray = this.parseArrayParameter(fileTypes);
      const excludePatternsArray = this.parseArrayParameter(excludePatterns);

      // Add default excludes for common directories
      const defaultExcludes = ['node_modules/**', '.git/**', 'dist/**', 'build/**'];
      const allExcludes = [...defaultExcludes, ...excludePatternsArray];

      const options = {
        cwd: searchPath,
        dot: includeHidden,
        nodir: true,
        ignore: allExcludes,
      };

      // Smart pattern handling
      let searchPattern = pattern;
      
      // If pattern doesn't include path separators, make it recursive
      if (!pattern.includes('/') && !pattern.startsWith('**')) {
        searchPattern = `**/${pattern}`;
      }
      
      // Modify pattern based on file types if specified
      if (fileTypesArray.length > 0) {
        if (pattern.includes('*') && !pattern.includes('.')) {
          searchPattern = `**/${pattern}.{${fileTypesArray.join(',')}}`;
        }
      }

      console.error(`[DEBUG] Searching with pattern: ${searchPattern} in ${searchPath}`);
      const files = await glob(searchPattern, options);

      console.error(`[DEBUG] Searching with pattern: ${searchPattern} in ${searchPath}`);
      const foundFiles = await glob(searchPattern, options);

      // Limit results
      const limitedFiles = foundFiles.slice(0, maxResults);

      let result = `🔍 **Search Results for "${pattern}" in ${searchPath}**\n\n`;
      result += `**Pattern used:** ${searchPattern}\n`;
      result += `**Search path:** ${searchPath}\n\n`;
      
      if (limitedFiles.length === 0) {
        result += "No files found matching the pattern.";
        
        // Provide helpful suggestions
        result += "\n\n**💡 Suggestions:**\n";
        result += "- Try using `**/*.feature` for recursive search\n";
        result += "- Check if files exist with: `get_file_tree`\n";
        result += "- Use `explore_directory` to browse the structure\n";
      } else {
        limitedFiles.forEach(file => {
          result += `📄 ${file}\n`;
        });
        
        if (foundFiles.length > maxResults) {
          result += `\n⚠️ **Showing ${maxResults} of ${foundFiles.length} results** (use maxResults parameter to see more)\n`;
        }
        
        result += `\n**Total: ${foundFiles.length} files found**`;
      }

      return {
        content: [{
          type: "text",
          text: result,
        }],
        isError: false,
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ **Error searching files:** ${error.message}`,
        }],
        isError: true,
      };
    }
  }

  async handleSearchContent(args) {
    try {
      const { 
        pattern, 
        searchPath = process.cwd(), 
        fileTypes = "", 
        excludePatterns = "",
        caseSensitive = false,
        contextLines = 2,
        maxResults = 50,
        isRegex = false
      } = args;

      // Parse comma-separated parameters into arrays
      const fileTypesArray = this.parseArrayParameter(fileTypes);
      const excludePatternsArray = this.parseArrayParameter(excludePatterns);

      // Add default excludes for binary files and common directories
      const defaultExcludes = [
        'node_modules/**', '.git/**', 'dist/**', 'build/**', 
        '*.jpg', '*.jpeg', '*.png', '*.gif', '*.pdf', '*.zip', 
        '*.exe', '*.dll', '*.so', '*.dylib',
        ...excludePatternsArray
      ];

      const searchPattern = fileTypesArray.length > 0 
        ? `**/*.{${fileTypesArray.join(',')}}`
        : '**/*';

      const files = await glob(searchPattern, { 
        cwd: searchPath, 
        nodir: true,
        ignore: defaultExcludes
      });

      const regex = isRegex 
        ? new RegExp(pattern, caseSensitive ? 'g' : 'gi')
        : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'g' : 'gi');
      
      const results = [];

      for (const file of files) {
        const filePath = path.join(searchPath, file);
        try {
          const content = await fs.promises.readFile(filePath, 'utf8');
          const lines = content.split('\n');
          
          lines.forEach((line, index) => {
            if (regex.test(line)) {
              // Get context lines
              const start = Math.max(0, index - contextLines);
              const end = Math.min(lines.length, index + contextLines + 1);
              const contextLinesToShow = lines.slice(start, end);
              
              results.push({
                file,
                matchLine: index + 1,
                content: line.trim(),
                context: contextLinesToShow,
                contextStart: start + 1
              });
            }
          });
        } catch (error) {
          // Skip files that can't be read (binary, permissions, etc.)
        }
        
        // Limit results to avoid overwhelming output
        if (results.length >= maxResults) break;
      }

      let result = `🔍 **Content Search Results for "${pattern}" in ${searchPath}**\n\n`;
      result += `**Pattern:** ${pattern} (${isRegex ? 'regex' : 'text'})\n`;
      result += `**Files searched:** ${files.length}\n`;
      result += `**Context lines:** ${contextLines}\n\n`;
      
      if (results.length === 0) {
        result += "No content found matching the pattern.";
        result += "\n\n**💡 Suggestions:**\n";
        result += "- Try different case sensitivity setting\n";
        result += "- Use regex patterns for complex searches\n";
        result += "- Check file types filter\n";
      } else {
        results.forEach(({ file, matchLine, content, context, contextStart }) => {
          result += `📄 **${file}:${matchLine}**\n`;
          result += '```\n';
          
          context.forEach((contextLine, i) => {
            const lineNum = contextStart + i;
            const isMatch = lineNum === matchLine;
            const prefix = isMatch ? '→ ' : '  ';
            result += `${prefix}${lineNum.toString().padStart(4)}: ${contextLine}\n`;
          });
          
          result += '```\n\n';
        });
        
        if (results.length >= maxResults) {
          result += `⚠️ **Showing first ${maxResults} results** (use maxResults parameter for more)\n`;
        }
        
        result += `**Total: ${results.length} matches found**`;
      }

      return {
        content: [{
          type: "text",
          text: result,
        }],
        isError: false,
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ **Error searching content:** ${error.message}`,
        }],
        isError: true,
      };
    }
  }

  async handleReadFileContent(args) {
    try {
      const { 
        filePath, 
        startLine, 
        endLine, 
        maxLines,
        encoding = 'utf8',
        showLineNumbers = true,
        syntax
      } = args;

      const content = await fs.promises.readFile(filePath, encoding);
      const lines = content.split('\n');

      let resultContent;
      let actualStartLine = 1;
      let actualEndLine = lines.length;

      if (startLine || endLine || maxLines) {
        const start = startLine ? Math.max(1, startLine) - 1 : 0;
        let end = endLine ? Math.min(lines.length, endLine) : lines.length;
        
        if (maxLines && (end - start) > maxLines) {
          end = start + maxLines;
        }
        
        actualStartLine = start + 1;
        actualEndLine = end;
        
        const selectedLines = lines.slice(start, end);
        
        if (showLineNumbers) {
          const maxLineNumWidth = actualEndLine.toString().length;
          resultContent = selectedLines
            .map((line, i) => {
              const lineNum = (actualStartLine + i).toString().padStart(maxLineNumWidth);
              return `${lineNum}: ${line}`;
            })
            .join('\n');
        } else {
          resultContent = selectedLines.join('\n');
        }
      } else {
        if (showLineNumbers) {
          const maxLineNumWidth = lines.length.toString().length;
          resultContent = lines
            .map((line, i) => {
              const lineNum = (i + 1).toString().padStart(maxLineNumWidth);
              return `${lineNum}: ${line}`;
            })
            .join('\n');
        } else {
          resultContent = content;
        }
      }

      // Detect syntax from file extension if not provided
      let detectedSyntax = syntax;
      if (!detectedSyntax) {
        const ext = path.extname(filePath).toLowerCase();
        const syntaxMap = {
          '.js': 'javascript',
          '.ts': 'typescript',
          '.py': 'python',
          '.java': 'java',
          '.json': 'json',
          '.md': 'markdown',
          '.css': 'css',
          '.html': 'html',
          '.xml': 'xml',
          '.yml': 'yaml',
          '.yaml': 'yaml',
          '.sh': 'bash',
          '.sql': 'sql',
          '.feature': 'gherkin'
        };
        detectedSyntax = syntaxMap[ext] || 'text';
      }

      const lineInfo = (startLine || endLine || maxLines)
        ? ` (lines ${actualStartLine}-${actualEndLine})`
        : ` (${lines.length} lines)`;

      let result = `📄 **File: ${filePath}${lineInfo}**\n\n`;
      result += `**Size:** ${resultContent.length} characters\n`;
      result += `**Syntax:** ${detectedSyntax}\n\n`;
      result += `\`\`\`${detectedSyntax}\n`;
      result += resultContent;
      result += '\n```';

      return {
        content: [{
          type: "text",
          text: result,
        }],
        isError: false,
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ **Error reading file:** ${error.message}`,
        }],
        isError: true,
      };
    }
  }

  async handleAnalyzeFile(args) {
    try {
      const { filePath } = args;

      const stats = await fs.promises.stat(filePath);
      const content = await fs.promises.readFile(filePath, 'utf8');
      const lines = content.split('\n');

      let result = `📊 **File Analysis: ${filePath}**\n\n`;
      result += `**Size:** ${this.formatFileSize(stats.size)}\n`;
      result += `**Lines:** ${lines.length}\n`;
      result += `**Extension:** ${path.extname(filePath)}\n`;
      result += `**Modified:** ${stats.mtime.toISOString()}\n\n`;

      // Basic content analysis
      const nonEmptyLines = lines.filter(line => line.trim().length > 0).length;
      const avgLineLength = lines.reduce((sum, line) => sum + line.length, 0) / lines.length;
      
      result += `**Non-empty lines:** ${nonEmptyLines}\n`;
      result += `**Average line length:** ${avgLineLength.toFixed(1)} characters\n`;

      // Detect file type
      const ext = path.extname(filePath).toLowerCase();
      const fileTypes = {
        '.js': 'JavaScript',
        '.ts': 'TypeScript',
        '.py': 'Python',
        '.java': 'Java',
        '.json': 'JSON',
        '.md': 'Markdown',
        '.txt': 'Text',
        '.css': 'CSS',
        '.html': 'HTML',
      };
      
      if (fileTypes[ext]) {
        result += `**File type:** ${fileTypes[ext]}\n`;
      }

      return {
        content: [{
          type: "text",
          text: result,
        }],
        isError: false,
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ **Error analyzing file:** ${error.message}`,
        }],
        isError: true,
      };
    }
  }

  async handleGetFileTree(args) {
    try {
      const { 
        directoryPath = process.cwd(), 
        depth = 3, 
        fileTypes = "",
        excludePatterns = "",
        includeHidden = false 
      } = args;
      
      // Parse comma-separated parameters into arrays
      const fileTypesArray = this.parseArrayParameter(fileTypes);
      const excludePatternsArray = this.parseArrayParameter(excludePatterns);
      
      const tree = await this.buildFileTree(directoryPath, depth, includeHidden, 0, {
        fileTypes: fileTypesArray,
        excludePatterns: excludePatternsArray
      });
      
      return {
        content: [{
          type: "text",
          text: `📁 **File Tree for ${directoryPath}**\n\n${tree}`,
        }],
        isError: false,
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ **Error getting file tree:** ${error.message}`,
        }],
        isError: true,
      };
    }
  }

  async handleCompareFiles(args) {
    try {
      const { file1, file2 } = args;

      const content1 = await fs.promises.readFile(file1, 'utf8');
      const content2 = await fs.promises.readFile(file2, 'utf8');

      const lines1 = content1.split('\n');
      const lines2 = content2.split('\n');

      let result = `🔍 **File Comparison: ${file1} vs ${file2}**\n\n`;
      
      if (content1 === content2) {
        result += "✅ Files are identical.";
      } else {
        result += `**File 1 lines:** ${lines1.length}\n`;
        result += `**File 2 lines:** ${lines2.length}\n\n`;
        
        // Simple line-by-line comparison
        const maxLines = Math.max(lines1.length, lines2.length);
        let differences = 0;
        
        for (let i = 0; i < Math.min(maxLines, 10); i++) {
          const line1 = lines1[i] || '';
          const line2 = lines2[i] || '';
          
          if (line1 !== line2) {
            differences++;
            result += `**Line ${i + 1}:**\n`;
            result += `- ${file1}: ${line1}\n`;
            result += `+ ${file2}: ${line2}\n\n`;
          }
        }
        
        if (differences === 0 && maxLines <= 10) {
          result += "Files have different lengths but shown lines are identical.";
        } else if (maxLines > 10) {
          result += `(Showing first 10 lines of comparison. Total differences may be more.)`;
        }
      }

      return {
        content: [{
          type: "text",
          text: result,
        }],
        isError: false,
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ **Error comparing files:** ${error.message}`,
        }],
        isError: true,
      };
    }
  }

  async handleGetProjectStats(args) {
    try {
      const { 
        projectPath = process.cwd(),
        excludePatterns = ""
      } = args;

      // Parse comma-separated parameters into arrays
      const excludePatternsArray = this.parseArrayParameter(excludePatterns);

      const stats = {
        totalFiles: 0,
        totalSize: 0,
        fileTypes: {},
        directories: 0,
      };

      const files = await glob('**/*', { 
        cwd: projectPath, 
        dot: false,
        ignore: excludePatternsArray
      });

      for (const file of files) {
        const filePath = path.join(projectPath, file);
        try {
          const fileStat = await fs.promises.stat(filePath);
          if (fileStat.isFile()) {
            stats.totalFiles++;
            stats.totalSize += fileStat.size;
            
            const ext = path.extname(file).toLowerCase() || 'no extension';
            stats.fileTypes[ext] = (stats.fileTypes[ext] || 0) + 1;
          } else if (fileStat.isDirectory()) {
            stats.directories++;
          }
        } catch (error) {
          // Skip files that can't be accessed
        }
      }

      let result = `📊 **Project Statistics: ${projectPath}**\n\n`;
      result += `**Total files:** ${stats.totalFiles}\n`;
      result += `**Total directories:** ${stats.directories}\n`;
      result += `**Total size:** ${this.formatFileSize(stats.totalSize)}\n\n`;
      
      result += `**File types:**\n`;
      const sortedTypes = Object.entries(stats.fileTypes)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 10);
      
      sortedTypes.forEach(([ext, count]) => {
        result += `  ${ext}: ${count} files\n`;
      });

      return {
        content: [{
          type: "text",
          text: result,
        }],
        isError: false,
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ **Error getting project stats:** ${error.message}`,
        }],
        isError: true,
      };
    }
  }

  async handleQuickRepoOverview(args) {
    try {
      const {
        repoPath = process.cwd(),
        maxDepth = 3,
        includeFileContent = true,
        keyFilePatterns = "README*,package.json,*.md,*.feature,tsconfig.json,pom.xml,requirements.txt"
      } = args;

      let result = `📊 **Repository Overview: ${repoPath}**\n\n`;

      // 1. Basic repository info
      try {
        const stats = await fs.promises.stat(repoPath);
        result += `**Path:** ${repoPath}\n`;
        result += `**Type:** ${stats.isDirectory() ? 'Directory' : 'File'}\n`;
        result += `**Modified:** ${stats.mtime.toISOString()}\n\n`;
      } catch (error) {
        result += `**Warning:** Cannot access path ${repoPath}\n\n`;
      }

      // 2. Git information
      try {
        if (fs.existsSync(path.join(repoPath, '.git'))) {
          const { stdout: currentBranch } = await execAsync('git branch --show-current', { cwd: repoPath });
          const { stdout: remoteUrl } = await execAsync('git remote get-url origin', { cwd: repoPath }).catch(() => ({ stdout: 'No remote origin' }));
          result += `🌿 **Git Information:**\n`;
          result += `- Current branch: ${currentBranch.trim()}\n`;
          result += `- Remote origin: ${remoteUrl.trim()}\n\n`;
        }
      } catch (error) {
        // Skip git info if not available
      }

      // 3. Directory structure
      result += `📁 **Directory Structure (depth ${maxDepth}):**\n`;
      try {
        const tree = await this.buildFileTree(repoPath, maxDepth, false, 0, {
          excludePatterns: ['node_modules', '.git', 'dist', 'build', 'target']
        });
        result += `\`\`\`\n${tree}\`\`\`\n\n`;
      } catch (error) {
        result += `Error building tree: ${error.message}\n\n`;
      }

      // 4. Find and analyze key files
      result += `📋 **Key Files:**\n`;
      const keyPatterns = this.parseArrayParameter(keyFilePatterns);
      const foundKeyFiles = [];

      for (const pattern of keyPatterns) {
        try {
          const files = await glob(pattern.includes('**') ? pattern : `**/${pattern}`, {
            cwd: repoPath,
            nodir: true,
            ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**', 'target/**']
          });
          foundKeyFiles.push(...files);
        } catch (error) {
          // Skip patterns that fail
        }
      }

      // Remove duplicates and sort
      const uniqueKeyFiles = [...new Set(foundKeyFiles)].sort();

      if (uniqueKeyFiles.length === 0) {
        result += "No key files found.\n\n";
      } else {
        for (const file of uniqueKeyFiles.slice(0, 10)) { // Limit to first 10
          result += `📄 **${file}**\n`;
          
          if (includeFileContent) {
            try {
              const filePath = path.join(repoPath, file);
              const stats = await fs.promises.stat(filePath);
              
              if (stats.size < 10000) { // Only include small files
                const content = await fs.promises.readFile(filePath, 'utf8');
                const lines = content.split('\n');
                
                if (lines.length <= 20) {
                  result += `\`\`\`\n${content}\`\`\`\n\n`;
                } else {
                  result += `\`\`\`\n${lines.slice(0, 15).join('\n')}\n... (${lines.length - 15} more lines)\`\`\`\n\n`;
                }
              } else {
                result += `   (File too large: ${this.formatFileSize(stats.size)})\n\n`;
              }
            } catch (error) {
              result += `   (Could not read file: ${error.message})\n\n`;
            }
          } else {
            result += "\n";
          }
        }
        
        if (uniqueKeyFiles.length > 10) {
          result += `... and ${uniqueKeyFiles.length - 10} more key files\n\n`;
        }
      }

      // 5. Quick project type detection
      result += `🔍 **Project Type Detection:**\n`;
      const projectIndicators = [
        { pattern: 'package.json', type: 'Node.js/JavaScript' },
        { pattern: 'pom.xml', type: 'Java/Maven' },
        { pattern: 'requirements.txt', type: 'Python' },
        { pattern: 'Cargo.toml', type: 'Rust' },
        { pattern: '*.csproj', type: '.NET/C#' },
        { pattern: '*.feature', type: 'Behavior-Driven Development (BDD)' },
        { pattern: 'tsconfig.json', type: 'TypeScript' },
        { pattern: 'gradle.properties', type: 'Java/Gradle' }
      ];

      const detectedTypes = [];
      for (const indicator of projectIndicators) {
        try {
          const files = await glob(indicator.pattern.includes('**') ? indicator.pattern : `**/${indicator.pattern}`, {
            cwd: repoPath,
            nodir: true,
            ignore: ['node_modules/**', '.git/**']
          });
          if (files.length > 0) {
            detectedTypes.push(indicator.type);
          }
        } catch (error) {
          // Skip failed patterns
        }
      }

      if (detectedTypes.length > 0) {
        result += detectedTypes.map(type => `- ${type}`).join('\n') + '\n\n';
      } else {
        result += "No specific project type detected\n\n";
      }

      result += `✅ **Overview complete!**\n`;
      result += `Use specific tools like \`search_files\`, \`read_file_content\`, or \`search_content\` for detailed exploration.`;

      return {
        content: [{
          type: "text",
          text: result,
        }],
        isError: false,
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `❌ **Error creating repository overview:** ${error.message}`,
        }],
        isError: true,
      };
    }
  }

  // Helper function to parse comma-separated string parameters into arrays
  parseArrayParameter(param) {
    if (!param || param.trim() === '') {
      return [];
    }
    return param.split(',').map(item => item.trim()).filter(item => item.length > 0);
  }

  async handleExecuteGatlingSimulation(args) {
    const {
      simulationClass,
      workingDirectory,
      mavenExecutable = "mvn",
      gatlingParams = "",
    } = args;

    try {
      if (!simulationClass) {
        throw new Error("simulationClass is required");
      }
      // Allow override of workDir if workingDirectory is provided
      const workDir = workingDirectory || "/opt/gatling";
      // Build command
      let command = `${mavenExecutable} gatling:test -Dgatling.simulationClass=${simulationClass} -Dlogback.configurationFile=logback.xml`;
      if (gatlingParams && gatlingParams.trim()) {
        command += ` ${gatlingParams.trim()}`;
      }
      console.error(`[DEBUG] Executing Gatling simulation: ${command}`);
      console.error(`[DEBUG] Working directory: ${workDir}`);
      const { stdout, stderr } = await execAsync(command, {
        cwd: workDir,
        timeout: 1200000,
      });
      const output = stdout + stderr;
      let resultText = `🚀 **Gatling Simulation Execution Complete**\n\n`;
      resultText += `**Simulation Class:** ${simulationClass}\n`;
      resultText += `**Working Directory:** ${workDir}\n`;
      resultText += `**Maven Executable:** ${mavenExecutable}\n`;
      if (gatlingParams) resultText += `**Gatling Params:** ${gatlingParams}\n`;
      resultText += `**Timeout:** 1200000 ms\n\n`;
      if (output.trim()) {
        // Only include the last 10 lines of output
        const lines = output.trim().split('\n');
        const lastLines = lines.slice(-10).join('\n');
        resultText += `**Output (last 10 lines):**\n\u0060\u0060\u0060\n${lastLines}\n\u0060\u0060\u0060\n\n`;
      } else {
        resultText += `**Output:** (no output)\n\n`;
      }
      resultText += `✅ **Gatling simulation executed successfully**`;
      console.error(`[DEBUG] Output: ${resultText}`);
      return {
        content: [{
          type: "text",
          text: resultText,
        }],
        isError: false,
      };
    } catch (error) {
      let errorText = `❌ **Gatling Simulation Execution Failed**\n\n`;
      errorText += `**Simulation Class:** ${simulationClass}\n`;
      errorText += `**Working Directory:** ${workingDirectory || path.join(process.cwd(), "gatling")}\n`;
      errorText += `**Maven Executable:** ${mavenExecutable}\n`;
      if (gatlingParams) errorText += `**Gatling Params:** ${gatlingParams}\n`;
      errorText += `**Error:** ${error.message}\n\n`;
      if (error.stderr) {
        errorText += `**Details:**\n\u0060\u0060\u0060\n${error.stderr}\n\u0060\u0060\u0060`;
      }
      return {
        content: [{
          type: "text",
          text: errorText,
        }],
        isError: true,
      };
    }
  }

  // --- New: Git Clone Tool Handler ---
  async handleGitClone(args) {
    const { repoUrl, branch = "main", targetDirectory = "" } = args;
    try {
      if (!repoUrl) {
        throw new Error("repoUrl is required");
      }
      // Determine target directory name if not provided
      let cloneDir = targetDirectory;
      if (!cloneDir) {
        // Extract repo name from URL
        const match = repoUrl.match(/\/([^\/]+)\.git$/);
        cloneDir = match ? match[1] : "cloned-repo";
      }
      const command = `git clone ${repoUrl} -b ${branch} ${cloneDir}`;
      console.error(`[DEBUG] Cloning repo: ${command}`);
      const { stdout, stderr } = await execAsync(command, { timeout: 300000 }); // 5 min timeout
      let resultText = `🌱 **Git Clone Complete**\n\n`;
      resultText += `**Repo URL:** ${repoUrl}\n`;
      resultText += `**Branch:** ${branch}\n`;
      resultText += `**Target Directory:** ${cloneDir}\n\n`;
      if (stdout.trim()) {
        resultText += `**Output:**\n\u0060\u0060\u0060\n${stdout.trim()}\n\u0060\u0060\u0060\n`;
      }
      if (stderr.trim()) {
        resultText += `**Warnings/Errors:**\n\u0060\u0060\u0060\n${stderr.trim()}\n\u0060\u0060\u0060\n`;
      }
      resultText += `✅ **Repository cloned and branch checked out.**`;
      return {
        content: [{ type: "text", text: resultText }],
        isError: false,
      };
    } catch (error) {
      let errorText = `❌ **Git Clone Failed**\n\n`;
      errorText += `**Repo URL:** ${args.repoUrl}\n`;
      errorText += `**Branch:** ${args.branch || "main"}\n`;
      errorText += `**Error:** ${error.message}\n\n`;
      if (error.stderr) {
        errorText += `**Details:**\n\u0060\u0060\u0060\n${error.stderr}\n\u0060\u0060\u0060`;
      }
      return {
        content: [{ type: "text", text: errorText }],
        isError: true,
      };
    }
  }

  async handleGitPull(args) {
    const { workingDirectory } = args;
    try {
      if (!workingDirectory) {
        throw new Error("workingDirectory is required");
      }
      if (!fs.existsSync(path.join(workingDirectory, '.git'))) {
        throw new Error(`Not a git repository: ${workingDirectory}`);
      }
      const command = `git pull`;
      console.error(`[DEBUG] Executing git pull in: ${workingDirectory}`);
      const { stdout, stderr } = await execAsync(command, { cwd: workingDirectory, timeout: 60000 });
      let resultText = `⬇️ **Git Pull Complete**\n\n`;
      resultText += `**Working Directory:** ${workingDirectory}\n\n`;
      if (stdout.trim()) {
        resultText += `**Output:**\n\u0060\u0060\u0060\n${stdout.trim()}\n\u0060\u0060\u0060\n`;
      }
      if (stderr.trim()) {
        resultText += `**Warnings/Errors:**\n\u0060\u0060\u0060\n${stderr.trim()}\n\u0060\u0060\u0060\n`;
      }
      resultText += `✅ **Repository updated with latest changes.**`;
      return {
        content: [{ type: "text", text: resultText }],
        isError: false,
      };
    } catch (error) {
      let errorText = `❌ **Git Pull Failed**\n\n`;
      errorText += `**Working Directory:** ${args.workingDirectory}\n`;
      errorText += `**Error:** ${error.message}\n\n`;
      if (error.stderr) {
        errorText += `**Details:**\n\u0060\u0060\u0060\n${error.stderr}\n\u0060\u0060\u0060`;
      }
      return {
        content: [{ type: "text", text: errorText }],
        isError: true,
      };
    }
  }

  async handleGetErrors(args) {
    const workingDirectory = args.workingDirectory || "/opt/gatling";
    const scriptPath = "/opt/errors_parser.py";
    const pythonExecutable = "python3";
    try {
      if (!fs.existsSync(scriptPath)) {
        throw new Error(`Script not found: ${scriptPath}`);
      }
      // Run the parser script with workingDirectory as argument
      const command = `${pythonExecutable} ${scriptPath} '${workingDirectory}'`;
      console.error(`[DEBUG] Executing get_errors: ${command}`);
      const { stdout, stderr } = await execAsync(command, { timeout: 60000 });
      let resultText = `🪲 **Parsed Gatling Errors**\n\n`;
      if (stdout.trim()) {
        resultText += `\u0060\u0060\u0060json\n${stdout.trim()}\n\u0060\u0060\u0060\n`;
      } else {
        resultText += `No errors found or output is empty.`;
      }
      if (stderr.trim()) {
        resultText += `\n**Warnings/Errors:**\n\u0060\u0060\u0060\n${stderr.trim()}\n\u0060\u0060\u0060`;
      }
      return {
        content: [{ type: "text", text: resultText }],
        isError: false,
      };
    } catch (error) {
      let errorText = `❌ **Get Errors Failed**\n\n`;
      errorText += `**Working Directory:** ${workingDirectory}\n`;
      errorText += `**Error:** ${error.message}\n\n`;
      if (error.stderr) {
        errorText += `**Details:**\n\u0060\u0060\u0060\n${error.stderr}\n\u0060\u0060\u0060`;
      }
      return {
        content: [{ type: "text", text: errorText }],
        isError: true,
      };
    }
  }

  async handleClaudeCode(args) {
    console.error("==========================");
    console.error("started handleClaudeCode with args");
    console.error(args);
    console.error("==========================");
    const { prompt, workingDirectory = "" } = args;
    return new Promise((resolve) => {
      if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
        resolve({
          content: [{ type: "text", text: "Prompt is required and must be a non-empty string." }],
          isError: true,
        });
        return;
      }
      const cmd = "claude";
      const cliArgs = ["--permission-mode", "bypassPermissions", "-p", prompt];
      const execOptions = { timeout: 6000000, env: { ...process.env } };
      if (workingDirectory && workingDirectory.trim()) {
        execOptions.cwd = workingDirectory;
      }
      let stdout = "";
      let stderr = "";
      const child = spawn(cmd, cliArgs, execOptions);
      child.stdout.on("data", (data) => { stdout += data.toString(); });
      child.stderr.on("data", (data) => { stderr += data.toString(); });
      child.on("close", (code, signal) => {
        console.error(`[DEBUG] Claude process closed with code: ${code}, signal: ${signal}`);
        const getLastLines = (str, n) => {
          if (!str) return "";
          const lines = str.trim().split('\n');
          return lines.slice(-n).join('\n');
        };
        let resultText = `⚡ **Claude CLI Execution Complete**\n\n`;
        resultText += `**Prompt:** ${prompt}\n`;
        resultText += `**Working Directory:** ${workingDirectory || process.cwd()}\n\n`;
        if (stdout.trim()) {
          resultText += `**Output:**\n\u0060\u0060\u0060\n${stdout.trim()}\n\u0060\u0060\u0060\n`;
        }
        if (stderr.trim()) {
          resultText += `**Warnings/Errors:**\n\u0060\u0060\u0060\n${stderr.trim()}\n\u0060\u0060\u0060\n`;
        }
        if (code === 0) {
          resultText += `✅ **Claude command executed.**`;
          console.error("-----------------------------");
          console.error(resultText);
          console.error("-----------------------------");
          resolve({
            content: [{ type: "text", text: resultText }],
            isError: false,
          });
        } else {
          resultText += `❌ **Claude CLI exited with code ${code}**`;
          resolve({
            content: [{ type: "text", text: resultText }],
            isError: true,
          });
        }
      });
      child.on("exit", (code, signal) => {
        console.error(`[DEBUG] Claude process exit event: code=${code}, signal=${signal}`);
      });
      child.on("error", (err) => {
        console.error("-----------------------------");
        console.error("Failed to execute claude code");
        console.error(err);
        console.error("-----------------------------");
        resolve({
          content: [{ type: "text", text: `❌ **Claude CLI failed to start:** ${err.message}` }],
          isError: true,
        });
      });
      // Ensure stdin is closed
      if (child.stdin) {
        child.stdin.end();
      }
    });
  }

  async handleGitCommitAndPush(args) {
    const { workingDirectory, commitMessage = "commit fixes by codex" } = args;
    try {
      if (!workingDirectory) {
        throw new Error("workingDirectory is required");
      }
      if (!fs.existsSync(path.join(workingDirectory, '.git'))) {
        throw new Error(`Not a git repository: ${workingDirectory}`);
      }
      // 1. git status --porcelain to get changed/untracked files
      const { stdout: statusOut } = await execAsync('git status --porcelain', { cwd: workingDirectory });
      const lines = statusOut.split('\n').filter(l => l.trim());
      // Exclude any file inside a target/ directory (at any depth) and errors.json
      const filesToAdd = lines
        .map(l => l.replace(/^\s*[AM\?]{1,2}\s*/, ''))
        .filter(f => f && !f.split(path.sep).includes('target') && path.basename(f) !== 'errors.json');
      let resultText = `🚀 **Git Commit & Push**\n\n`;
      resultText += `**Working Directory:** ${workingDirectory}\n`;
      resultText += `**Files to add:**\n`;
      if (filesToAdd.length === 0) {
        resultText += `No changed or untracked files to add.\n`;
        return {
          content: [{ type: "text", text: resultText }],
          isError: false,
        };
      }
      filesToAdd.forEach(f => { resultText += `- ${f}\n`; });
      // 2. git add files
      for (const file of filesToAdd) {
        await execAsync(`git add "${file}"`, { cwd: workingDirectory });
      }
      // 3. git commit
      await execAsync(`git commit -m "${commitMessage}"`, { cwd: workingDirectory });
      // 4. get current branch
      const { stdout: branchOut } = await execAsync('git branch --show-current', { cwd: workingDirectory });
      const branch = branchOut.trim();
      // 5. git push origin branch
      const { stdout: pushOut, stderr: pushErr } = await execAsync(`git push origin ${branch}`, { cwd: workingDirectory });
      resultText += `\n**Commit message:** ${commitMessage}\n`;
      resultText += `**Branch:** ${branch}\n`;
      resultText += `**Push output (last 10 lines):**\n\u0060\u0060\u0060\n${pushOut.split('\n').slice(-10).join('\n')}\n\u0060\u0060\u0060\n`;
      if (pushErr.trim()) {
        resultText += `**Push errors (last 10 lines):**\n\u0060\u0060\u0060\n${pushErr.split('\n').slice(-10).join('\n')}\n\u0060\u0060\u0060\n`;
      }
      resultText += `✅ **Commit and push completed.**`;
      return {
        content: [{ type: "text", text: resultText }],
        isError: false,
      };
    } catch (error) {
      let errorText = `❌ **Git Commit & Push Failed**\n\n`;
      errorText += `**Working Directory:** ${args.workingDirectory}\n`;
      errorText += `**Error:** ${error.message}\n\n`;
      if (error.stderr) {
        errorText += `**Details (last 10 lines):**\n\u0060\u0060\u0060\n${error.stderr.split('\n').slice(-10).join('\n')}\n\u0060\u0060\u0060`;
      }
      return {
        content: [{ type: "text", text: errorText }],
        isError: true,
      };
    }
  }
}

// Export the class for testing
export default LocalMCPServer;

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new LocalMCPServer();
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.error('[DEBUG] Received SIGINT, shutting down gracefully...');
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.error('[DEBUG] Received SIGTERM, shutting down gracefully...');
    process.exit(0);
  });
  
  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error('[DEBUG] Uncaught exception:', error);
    process.exit(1);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[DEBUG] Unhandled rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });
  
  server.run().catch((error) => {
    console.error('[DEBUG] Server error:', error);
    process.exit(1);
  });
}
