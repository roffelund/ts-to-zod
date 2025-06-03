import { Command, Errors, Interfaces } from "@oclif/core";
import chokidar from "chokidar";
import { existsSync, readFile } from "fs-extra";
import { dirname, extname, join, relative, resolve } from "path";
import slash from "slash";
import { Config, InputOutputMapping, TsToZodConfig } from "../config";
import {
  // Import Config type for internal use
  getSchemaNameSchema,
  nameFilterSchema,
  tsToZodConfigSchema,
} from "../config.zod";
import { createConfig } from "../createConfig";
import { argsStatic, createFlags } from "./statics";
import { getInputOutputMappings } from "./utils";
import {
  executeCoreGeneration,
  prepareGeneratorConfig,
  validateGeneratedContent,
  writeOutputFiles,
} from "./generate-steps";
import inquirer from "inquirer";
import { uniq } from "lodash";
import ts from "typescript";

let config: TsToZodConfig | undefined;
let haveMultiConfig = false;
const configKeys: string[] = [];

function isEsm() {
  try {
    const packageJsonPath = join(process.cwd(), "package.json");
    const rawPackageJson = require(slash(relative(__dirname, packageJsonPath)));
    return rawPackageJson.type === "module";
  } catch (e) {}
  return false;
}

interface DiscoveredConfigForNestedGeneration {
  id: string; // absolute path, used as a unique identifier
  config: Config; // The actual config object for generation
  dependencies: Set<string>; // Set of ids (absolute paths) of other discovered configs it depends on
}

export type Flags = Interfaces.InferredFlags<typeof TsToZod.flags>;

// Try to load `ts-to-zod.config.c?js`
// We are doing this here to be able to infer the `flags` & `usage` in the cli help
const fileExtension = isEsm() ? "cjs" : "js";
const tsToZodConfigFileName = `ts-to-zod.config.${fileExtension}`;
const configPath = join(process.cwd(), tsToZodConfigFileName);

try {
  if (existsSync(configPath)) {
    const rawConfig = require(slash(relative(__dirname, configPath)));
    config = tsToZodConfigSchema.parse(rawConfig);
    if (Array.isArray(config)) {
      haveMultiConfig = true;
      configKeys.push(...config.map((c) => c.name));
    }
  }
} catch (e) {
  if (e instanceof Error) {
    Errors.error(
      `"${tsToZodConfigFileName}" invalid:
    ${e.message}
  
    Please fix the invalid configuration
    You can generate a new config with --init`,
      { exit: false }
    );
  }
  process.exit(2);
}

export class TsToZod extends Command {
  static description = "Generate Zod schemas from a Typescript file";

  static examples: Command.Example[] = [
    `$ ts-to-zod src/types.ts src/types.zod.ts`,
  ];

  static usage = haveMultiConfig
    ? [
        "--all",
        ...configKeys.map(
          (key) => `--config ${key.includes(" ") ? `"${key}"` : key}`
        ),
      ]
    : undefined;

  static flags = createFlags(
    tsToZodConfigFileName,
    configKeys,
    haveMultiConfig
  );

  static args = argsStatic;

  async run() {
    const { args, flags } = await this.parse(TsToZod);

    if (flags.init) {
      (await createConfig(configPath, tsToZodConfigFileName))
        ? this.log(`🧐 ${tsToZodConfigFileName} created!`)
        : this.log(`Nothing changed!`);
      return;
    }

    if (flags.generateNested) {
      if (!args.input) {
        this.error(
          `--generateNested requires an input file argument. Please provide a single input file.`
        );
      }

      if (flags.config || flags.all) {
        this.error(
          `--generateNested is not compatible with --config or --all flags. Please run it with a single input file argument only.`
        );
      }

      await this.runNestedGeneration(args.input, flags);
    } else {
      const fileConfig = await this.loadFileConfig(config, flags);

      const ioMappings = getInputOutputMappings(config);

      if (Array.isArray(fileConfig)) {
        if (args.input || args.output) {
          this.error(
            `INPUT and OUTPUT arguments are not compatible with --all`
          );
        }
        try {
          await Promise.all(
            fileConfig.map(async (config) => {
              this.log(`Generating "${config.name}"`);
              const result = await this.generate(
                args,
                config,
                flags,
                ioMappings
              );
              if (result.success) {
                this.log(` 🎉 Zod schemas generated!`);
              } else {
                this.error(result.error, { exit: false });
              }
              this.log(); // empty line between configs
            })
          );
        } catch (e) {
          const error =
            typeof e === "string" || e instanceof Error ? e : JSON.stringify(e);
          this.error(error);
        }
      } else {
        const result = await this.generate(args, fileConfig, flags, ioMappings);
        if (result.success) {
          this.log(`🎉 Zod schemas generated!`);
        } else {
          this.error(result.error);
        }
      }

      if (flags.watch && !flags.generateNested) {
        const inputs = Array.isArray(fileConfig)
          ? fileConfig.map((i) => i.input)
          : fileConfig?.input || args.input || [];

        this.log("\nWatching for changes…");
        chokidar.watch(inputs).on("change", async (path) => {
          console.clear();
          this.log(`Changes detected in "${slash(path)}"`);
          const config = Array.isArray(fileConfig)
            ? fileConfig.find((i) => i.input === slash(path))
            : fileConfig;

          const result = await this.generate(args, config, flags, ioMappings);
          if (result.success) {
            this.log(`🎉 Zod schemas generated!`);
          } else {
            this.error(result.error);
          }
          this.log("\nWatching for changes…");
        });
      }
    }
  }

  /**
   * Generate on zod schema file.
   * @param args
   * @param fileConfig
   * @param cliFlags
   * @param inputOutputMappings
   */
  async generate(
    args: { input?: string; output?: string },
    fileConfig: Config | undefined,
    cliFlags: Flags,
    inputOutputMappings: InputOutputMapping[]
  ): Promise<{ success: true } | { success: false; error: string }> {
    // Validate input/output arguments
    const prepareResult = await prepareGeneratorConfig(
      args,
      fileConfig,
      cliFlags,
      inputOutputMappings
    );

    if (!prepareResult.success) {
      return prepareResult;
    }

    const { inputPath, outputPath, generateOptions } = prepareResult.data;

    const outputProvided = Boolean(args.output || fileConfig?.output);

    // Execute core generation
    const coreGenerationExecutionResult = executeCoreGeneration(
      generateOptions,
      outputProvided
    );

    if (!coreGenerationExecutionResult.success) {
      return coreGenerationExecutionResult;
    }

    const coreGenerationData = coreGenerationExecutionResult.data;

    coreGenerationData.errors.map(this.warn.bind(this));

    // Validate generated content if needed
    if (!cliFlags.skipValidation) {
      const validationResult = await validateGeneratedContent(
        cliFlags,
        inputPath,
        outputPath,
        coreGenerationData,
        generateOptions,
        inputOutputMappings
      );

      if (!validationResult.success) {
        return validationResult;
      }
    }

    await writeOutputFiles(
      outputPath,
      inputPath,
      coreGenerationData,
      generateOptions
    );

    return { success: true };
  }

  // Interface for discovered configs during nested generation
  // private

  private async runNestedGeneration(initialInputFile: string, cliFlags: Flags) {
    this.log(
      `🚧 --generateNested is EXPERIMENTAL and may not work as expected. Use with caution!`
    );
    this.log("Starting nested generation with input file: " + initialInputFile);

    const initialAbsoluteInputFile = resolve(process.cwd(), initialInputFile);

    // 1. Discover all relevant files and their direct local TS/TSX imports
    // Map key: absolute file path
    // Map value: { relativePath: string (to cwd), localImportAbsPaths: Set<string> (abs paths of imports) }
    const discoveredFileInfos = new Map<
      string,
      { relativePath: string; localImportAbsPaths: Set<string> }
    >();

    await this.performFileDiscovery(
      initialAbsoluteInputFile,
      discoveredFileInfos,
      cliFlags.maxDepth,
      0
    );

    if (discoveredFileInfos.size === 0) {
      this.log(
        "No processable files found (including initial input). Nothing to generate."
      );
      return;
    }

    // 2. Build the final map of configs with resolved dependencies among the discovered set
    const configsForGeneration = new Map<
      string,
      DiscoveredConfigForNestedGeneration
    >();
    for (const [absPath, info] of discoveredFileInfos.entries()) {
      const deps = new Set<string>();
      for (const importedAbsPath of info.localImportAbsPaths) {
        if (discoveredFileInfos.has(importedAbsPath)) {
          // Only consider dependencies that are also part of the generation set
          deps.add(importedAbsPath);
        }
      }
      configsForGeneration.set(absPath, {
        id: absPath,
        config: {
          input: info.relativePath,
          output: info.relativePath.replace(/\.tsx?$/, ".zod.ts"),
          keepComments: cliFlags.keepComments || false,
          skipParseJSDoc: cliFlags.skipParseJSDoc || false,
          // inferredTypes: cliFlags.inferredTypes || undefined, // TODO: handle if needed for nested
        },
        dependencies: deps,
      });
    }

    const allConfigsToGenerate = Array.from(configsForGeneration.values());
    if (allConfigsToGenerate.length === 0) {
      this.log(
        "No files to generate after processing discovered imports. Nothing to generate."
      );
      return;
    }

    const globalIoMappings = this.buildGlobalIoMappings(
      allConfigsToGenerate.map((c) => c.config)
    );

    this.log(
      `Discovered ${allConfigsToGenerate.length} files for generation. Determining order and generating...`
    );

    // 3. Iterative generation based on dependencies
    const generatedConfigIds = new Set<string>();
    let generationQueue = [...allConfigsToGenerate];
    let totalGeneratedCount = 0;

    while (generationQueue.length > 0) {
      const batchToGenerate = generationQueue.filter((item) =>
        Array.from(item.dependencies).every((depId) =>
          generatedConfigIds.has(depId)
        )
      );

      if (batchToGenerate.length === 0) {
        const remainingFiles = generationQueue
          .map((item) => item.config.input)
          .join(", ");
        this.error(
          `Could not determine generation order. Possible circular dependency or missing files among: ${remainingFiles}. Please check your imports.`
        );
        return; // Should be unreachable
      }

      this.log(
        `Generation batch: ${batchToGenerate
          .map((item) => item.config.input)
          .join(", ")}`
      );

      const currentBatchPromises = batchToGenerate.map(
        async (itemToGenerate) => {
          this.log(
            `Generating for "${itemToGenerate.config.input}" (output: ${itemToGenerate.config.output})`
          );

          const result = await this.generate(
            {}, // No direct CLI args for input/output
            itemToGenerate.config,
            cliFlags,
            globalIoMappings
          );

          if (result.success) {
            this.log(
              `🎉 Zod schemas generated for ${itemToGenerate.config.output}!`
            );
            generatedConfigIds.add(itemToGenerate.id);
          } else {
            // This error will be caught by the Promise.all().catch() below
            throw new Error(
              `Error generating for ${itemToGenerate.config.input}: ${result.error}`
            );
          }
        }
      );

      try {
        await Promise.all(currentBatchPromises);
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        this.error(`Error during batch generation: ${errorMessage}`);
        return; // Should be unreachable
      }

      totalGeneratedCount += batchToGenerate.length;
      generationQueue = generationQueue.filter(
        (item) => !batchToGenerate.find((b) => b.id === item.id)
      );

      if (generationQueue.length > 0) {
        this.log(); // Empty line between batches if more are coming
      }
    }

    this.log(
      `\nSuccessfully generated schemas for ${totalGeneratedCount} files.`
    );
  }

  private buildGlobalIoMappings(configs: Config[]): InputOutputMapping[] {
    return configs.map((config) => ({
      input: config.input,
      output: config.output,
      getSchemaName: config.getSchemaName, // This will be undefined for nested, which is fine
    }));
  }

  // Helper function for the file discovery phase of nested generation
  private async performFileDiscovery(
    absoluteFilePath: string,
    // Map key: absolute file path, Value: { relativePath to cwd, Set of absolute paths of local TS/TSX imports }
    discoveredFileInfos: Map<
      string,
      { relativePath: string; localImportAbsPaths: Set<string> }
    >,
    maxDepth: number,
    currentDepth: number
  ) {
    if (currentDepth > maxDepth) {
      this.warn(
        `Maximum depth of ${maxDepth} reached for ${slash(
          relative(process.cwd(), absoluteFilePath)
        )}. Stopping further discovery on this path.`
      );
      return;
    }

    if (discoveredFileInfos.has(absoluteFilePath)) {
      this.debug(
        `Skipping already processed file for discovery: ${absoluteFilePath}`
      );
      return;
    }

    const relativeFilePath = slash(relative(process.cwd(), absoluteFilePath));
    this.log(
      `Discovering imports in: ${relativeFilePath} (depth: ${currentDepth})`
    );

    let sourceText: string;
    try {
      sourceText = await readFile(absoluteFilePath, "utf-8");
    } catch (e) {
      if (e instanceof Error) {
        this.warn(
          `Could not read file ${relativeFilePath} during discovery. Skipping. Error: ${e.message}`
        );
      }
      return;
    }

    // Add to map before parsing imports to handle cycles and mark as "visited"
    discoveredFileInfos.set(absoluteFilePath, {
      relativePath: relativeFilePath,
      localImportAbsPaths: new Set(), // Will be populated below
    });

    const sourceFile = ts.createSourceFile(
      absoluteFilePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true
    );
    const localImportsToExploreRecursively: string[] = [];

    ts.forEachChild(sourceFile, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const importPath = node.moduleSpecifier.text;
        if (importPath.startsWith("./") || importPath.startsWith("../")) {
          let resolvedImportAbsolutePath = resolve(
            dirname(absoluteFilePath),
            importPath
          );

          // Attempt to resolve .ts or .tsx if no extension
          if (!extname(resolvedImportAbsolutePath)) {
            if (existsSync(`${resolvedImportAbsolutePath}.ts`)) {
              resolvedImportAbsolutePath = `${resolvedImportAbsolutePath}.ts`;
            } else if (existsSync(`${resolvedImportAbsolutePath}.tsx`)) {
              resolvedImportAbsolutePath = `${resolvedImportAbsolutePath}.tsx`;
            }
            // Could add logic for index.ts in a directory if needed
          }

          // Check if the resolved import is a TS/TSX file and exists
          if (
            existsSync(resolvedImportAbsolutePath) &&
            (resolvedImportAbsolutePath.endsWith(".ts") ||
              resolvedImportAbsolutePath.endsWith(".tsx"))
          ) {
            // Add to current file's list of local imports
            discoveredFileInfos
              .get(absoluteFilePath)!
              .localImportAbsPaths.add(resolvedImportAbsolutePath);

            // And queue for further exploration if not already processed/discovered
            if (!discoveredFileInfos.has(resolvedImportAbsolutePath)) {
              localImportsToExploreRecursively.push(resolvedImportAbsolutePath);
            }
          } else {
            this.debug(
              `Local import "${importPath}" from "${relativeFilePath}" not found or not a TS/TSX file at "${resolvedImportAbsolutePath}". Skipping for discovery.`
            );
          }
        }
      }
    });

    for (const importPath of uniq(localImportsToExploreRecursively)) {
      await this.performFileDiscovery(
        importPath,
        discoveredFileInfos,
        maxDepth,
        currentDepth + 1
      );
    }
  }

  async loadFileConfig(
    config: TsToZodConfig | undefined,
    flags: Flags
  ): Promise<TsToZodConfig | undefined> {
    if (!config) {
      return undefined;
    }
    if (Array.isArray(config)) {
      if (!flags.all && !flags.config) {
        const { mode } = await inquirer.prompt<{
          mode: "none" | "multi" | `single-${string}`;
        }>([
          {
            name: "mode",
            message: `You have multiple configs available in "${tsToZodConfigFileName}"\n What do you want?`,
            type: "list",
            choices: [
              {
                value: "multi",
                name: `${TsToZod.flags.all.description} (--all)`,
              },
              ...configKeys.map((key) => ({
                value: `single-${key}`,
                name: `Execute "${key}" config (--config=${key})`,
              })),
              { value: "none", name: "Don't use the config" },
            ],
          },
        ]);
        if (mode.startsWith("single-")) {
          flags.config = mode.slice("single-".length);
        } else if (mode === "multi") {
          flags.all = true;
        }
      }
      if (flags.all) {
        return config;
      }
      if (flags.config) {
        const selectedConfig = config.find((c) => c.name === flags.config);
        if (!selectedConfig) {
          this.error(`${flags.config} configuration not found!`);
        }
        return selectedConfig;
      }
      return undefined;
    }

    return {
      ...config,
      getSchemaName: config.getSchemaName
        ? getSchemaNameSchema.implement(config.getSchemaName)
        : undefined,
      nameFilter: config.nameFilter
        ? nameFilterSchema.implement(config.nameFilter)
        : undefined,
    };
  }
}
