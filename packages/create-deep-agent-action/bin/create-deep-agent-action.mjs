#!/usr/bin/env node

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve, basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawnSync } from "node:child_process";

const ACTION_REF = "0aa91d295a53e472b0a8703d23c3cfc842164270";
const DEFAULTS = {
  directory: process.cwd(),
  model: "claude-sonnet-4-6",
  triggerPhrase: "@agent",
  workflowFile: "deep-agent.yml",
  guidance: true,
};

function usage() {
  return `Usage: npx create-deep-agent-action [options]

Creates a GitHub Actions workflow for Deep Agent Action in an existing Git repository.

Options:
  --directory <path>       Target repository (default: current directory)
  --model <model>          Deep Agent model (default: ${DEFAULTS.model})
  --trigger-phrase <text>  Agent mention trigger (default: ${DEFAULTS.triggerPhrase})
  --workflow-file <name>   Workflow file name (default: ${DEFAULTS.workflowFile})
  --no-guidance            Do not create .deepagents/AGENTS.md
  --force                  Replace generated files that already exist
  --yes                    Accept defaults without prompts
  --help                   Show this help
`;
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

function readOption(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function parseArgs(args) {
  const options = { ...DEFAULTS, yes: false, force: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--directory":
        options.directory = readOption(args, index, arg);
        index += 1;
        break;
      case "--model":
        options.model = readOption(args, index, arg);
        index += 1;
        break;
      case "--trigger-phrase":
        options.triggerPhrase = readOption(args, index, arg);
        index += 1;
        break;
      case "--workflow-file":
        options.workflowFile = readOption(args, index, arg);
        index += 1;
        break;
      case "--no-guidance":
        options.guidance = false;
        break;
      case "--force":
        options.force = true;
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function yamlString(value) {
  return JSON.stringify(value);
}

function workflow({ model, triggerPhrase }) {
  return `name: Deep Agent

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
  workflow_dispatch:
    inputs:
      prompt:
        description: "Instruction for the agent"
        required: true

permissions:
  contents: write
  pull-requests: write
  issues: write

concurrency:
  group: deep-agent-\${{ github.event.issue.number || github.event.pull_request.number || github.run_id }}
  cancel-in-progress: false

jobs:
  agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: dipjyotimetia/deep-agent-action@${ACTION_REF}
        with:
          model: ${yamlString(model)}
          trigger_phrase: ${yamlString(triggerPhrase)}
          prompt: \${{ github.event.inputs.prompt }}
          require_push_approval: true
        env:
          PROVIDER_API_KEY: \${{ secrets.PROVIDER_API_KEY }}
`;
}

function guidance() {
  return `# Deep Agent guidance

- Follow this repository's documented conventions and validation commands.
- Keep changes focused; preserve user-owned work and do not broaden the request.
- Do not store credentials, tokens, or transient task data in this file.
- Do not edit this guidance unless a maintainer explicitly asks.
`;
}

function assertWorkflowName(name) {
  if (basename(name) !== name || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.ya?ml$/.test(name)) {
    throw new Error("--workflow-file must be a YAML filename without path separators.");
  }
}

function assertGitRepository(directory) {
  const result = spawnSync("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
  });
  if (result.status !== 0 || result.stdout.trim() !== "true") {
    throw new Error(`\"${directory}\" is not a Git repository.`);
  }
}

function writeFile(path, content, force) {
  if (existsSync(path) && !force) {
    throw new Error(`${path} already exists. Re-run with --force to replace it.`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

async function collectInteractiveOptions(options) {
  if (options.yes || !stdin.isTTY || !stdout.isTTY) return options;
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const model = (await prompt.question(`Model [${options.model}]: `)).trim();
    const triggerPhrase = (
      await prompt.question(`Trigger phrase [${options.triggerPhrase}]: `)
    ).trim();
    const addGuidance = (
      await prompt.question("Create .deepagents/AGENTS.md guidance? [Y/n]: ")
    ).trim();
    return {
      ...options,
      ...(model ? { model } : {}),
      ...(triggerPhrase ? { triggerPhrase } : {}),
      guidance: !/^n(o)?$/i.test(addGuidance),
    };
  } finally {
    prompt.close();
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    options = await collectInteractiveOptions(options);
    options.directory = resolve(options.directory);
    assertWorkflowName(options.workflowFile);
    assertGitRepository(options.directory);

    const workflowPath = join(options.directory, ".github", "workflows", options.workflowFile);
    const guidancePath = join(options.directory, ".deepagents", "AGENTS.md");
    writeFile(workflowPath, workflow(options), options.force);
    if (options.guidance && (!existsSync(guidancePath) || options.force)) {
      writeFile(guidancePath, guidance(), options.force);
    }

    console.log(`Created ${workflowPath}`);
    if (options.guidance) {
      console.log(existsSync(guidancePath) ? `Kept or created ${guidancePath}` : "");
    }
    console.log(
      "Next: add PROVIDER_API_KEY as an Actions secret for your selected model provider.",
    );
    console.log(
      'To let the default token create pull requests, enable "Allow GitHub Actions to create and approve pull requests" in repository Actions settings.',
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

await main();
