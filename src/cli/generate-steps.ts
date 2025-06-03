import { outputFile, readFile } from "fs-extra";
import ora from "ora";
import { join, normalize, parse } from "path";
import prettier from "prettier";
import ts from "typescript";

import { Config, InputOutputMapping } from "../config";
import { generate as generateCoreFileContent } from "../core/generate";
import {
  areImportPathsEqualIgnoringExtension,
  getImportPath,
} from "../utils/getImportPath";
import * as worker from "../worker";
import { JAVASCRIPT_EXTENSIONS, TYPESCRIPT_EXTENSIONS } from "./constants";
import { hasExtensions } from "./utils";
import type { Flags } from "./TsToZod";
import { GenerateProps } from "../core/generate/generate.types";

// Define a type for the result of the core generation logic
export interface CoreGenerationResult {
  errors: string[];
  transformedSourceText: string;
  getZodSchemasFile: (zodSchemaOutputFilePath: string) => string;
  getIntegrationTestFile: (
    sourceImportPath: string,
    zodSchemasImportPath: string
  ) => string;
  getInferredTypes: (zodInferredTypesOutputFilePath: string) => string;
  hasCircularDependencies: boolean;
}

/**
 * Prepares paths, options, and reads the source file for generation.
 */
export async function prepareGeneratorConfig(
  args: { input?: string; output?: string },
  fileConfig: Config | undefined,
  cliFlags: Flags,
  globalIoMappings: InputOutputMapping[]
): Promise<
  | {
      success: true;
      data: {
        inputPath: string;
        outputPath: string;
        generateOptions: GenerateProps;
      };
    }
  | { success: false; error: string }
> {
  const input = args.input || fileConfig?.input;
  const output = args.output || fileConfig?.output;

  if (!input) {
    return {
      success: false,
      error: `Missing 1 required arg:\ninput file (typescript)\nSee more help with --help`,
    };
  }

  const inputPath = join(process.cwd(), input);
  const outputPath = join(process.cwd(), output || input);

  // Check args/flags file extensions
  const extErrors: { path: string; expectedExtensions: string[] }[] = [];
  if (!hasExtensions(input, TYPESCRIPT_EXTENSIONS)) {
    extErrors.push({
      path: input,
      expectedExtensions: TYPESCRIPT_EXTENSIONS,
    });
  }
  if (
    output &&
    !hasExtensions(output, [...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS])
  ) {
    extErrors.push({
      path: output,
      expectedExtensions: [...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS],
    });
  }

  if (extErrors.length) {
    return {
      success: false,
      error: `Unexpected file extension:\n${extErrors
        .map(
          ({ path, expectedExtensions }) =>
            `"${path}" must be ${expectedExtensions
              .map((i) => `"${i}"`)
              .join(", ")}`
        )
        .join("\n")}`,
    };
  }

  const sourceText = await readFile(inputPath, "utf-8");

  const relativeIoMappings = globalIoMappings.map((io) => ({
    input: getImportPath(inputPath, io.input),
    output: getImportPath(outputPath, io.output),
    getSchemaName: io.getSchemaName,
  }));

  const generateOptions: GenerateProps = {
    sourceText,
    inputOutputMappings: relativeIoMappings,
    ...fileConfig,
  };

  if (typeof cliFlags.keepComments === "boolean") {
    generateOptions.keepComments = cliFlags.keepComments;
  }
  if (typeof cliFlags.skipParseJSDoc === "boolean") {
    generateOptions.skipParseJSDoc = cliFlags.skipParseJSDoc;
  }
  if (typeof cliFlags.inferredTypes === "string") {
    generateOptions.inferredTypes = cliFlags.inferredTypes;
  }

  return {
    success: true,
    data: { inputPath, outputPath, generateOptions },
  };
}

/**
 * Executes the core zod schema generation logic.
 */
export function executeCoreGeneration(
  generateOptions: GenerateProps,
  outputProvided: boolean
):
  | { success: true; data: CoreGenerationResult }
  | { success: false; error: string } {
  const coreResult = generateCoreFileContent(generateOptions);

  if (coreResult.hasCircularDependencies && !outputProvided) {
    return {
      success: false,
      error:
        "--output= must also be provided when input files have some circular dependencies",
    };
  }
  return { success: true, data: coreResult };
}

/**
 * Validates the generated zod schemas and types.
 */
export async function validateGeneratedContent(
  cliFlags: Flags,
  inputPath: string, // actual input path for current generation
  outputPath: string, // actual output path for current generation
  coreGenResultData: CoreGenerationResult,
  generateOptions: GenerateProps, // contains skipParseJSDoc
  globalIoMappings: InputOutputMapping[] // for loading extra files
): Promise<{ success: true } | { success: false; error: string }> {
  const validatorSpinner = ora("Validating generated types").start();
  if (cliFlags.all) validatorSpinner.indent = 1;

  const extraFiles = [];
  for (const io of globalIoMappings) {
    // Only load extra files that are not the current input file
    if (getImportPath(inputPath, io.input) !== "/") {
      try {
        const fileInputPath = join(process.cwd(), io.input);
        const inputFile = await readFile(fileInputPath, "utf-8");
        extraFiles.push({
          sourceText: inputFile,
          relativePath: io.input,
        });
      } catch {
        validatorSpinner.warn(`File "${io.input}" not found`);
      }

      try {
        const fileOutputPath = join(process.cwd(), io.output);
        const outputFileContent = await readFile(fileOutputPath, "utf-8");
        extraFiles.push({
          sourceText: outputFileContent,
          relativePath: io.output,
        });
      } catch {
        validatorSpinner.warn(
          `File "${io.output}" not found: maybe it hasn't been generated yet?`
        );
      }
    }
  }

  let outputForValidation = outputPath;
  const input = inputPath.replace(process.cwd(), "").slice(1); // relative input
  const output = outputPath.replace(process.cwd(), "").slice(1); // relative output

  // If we're generating over the same file (or no output specified, defaulting to input),
  // we need to set a fake output path for validation to avoid conflicts.
  if (
    outputPath === inputPath ||
    areImportPathsEqualIgnoringExtension(input, output)
  ) {
    const outputFileName = "source.zod.ts"; // Temporary name for validation
    const { dir } = parse(normalize(inputPath));
    outputForValidation = join(dir, outputFileName);
  }

  const validationErrors = await worker.validateGeneratedTypesInWorker({
    sourceTypes: {
      sourceText: coreGenResultData.transformedSourceText,
      relativePath: input, // relative path for worker
    },
    integrationTests: {
      sourceText: coreGenResultData.getIntegrationTestFile(
        getImportPath("./source.integration.ts", input), // relative to input
        getImportPath("./source.integration.ts", outputForValidation) // relative to outputForValidation
      ),
      relativePath: "./source.integration.ts", // Fixed relative path for worker context
    },
    zodSchemas: {
      sourceText: coreGenResultData.getZodSchemasFile(
        getImportPath(outputForValidation, input) // relative to input
      ),
      relativePath: outputForValidation.replace(process.cwd(), "").slice(1), // relative path for worker
    },
    skipParseJSDoc: Boolean(generateOptions.skipParseJSDoc),
    extraFiles,
  });

  if (validationErrors.length > 0) {
    validatorSpinner.fail();
    return {
      success: false,
      error: validationErrors.join("\n"),
    };
  }

  validatorSpinner.succeed();
  return { success: true };
}

/**
 * Writes the generated Zod schemas and inferred types to files.
 */
export async function writeOutputFiles(
  outputPath: string, // actual output path
  inputPath: string, // actual input path
  coreGenResultData: CoreGenerationResult,
  generateOptions: GenerateProps // contains inferredTypes path
): Promise<void> {
  const zodSchemasFile = coreGenResultData.getZodSchemasFile(
    getImportPath(outputPath, inputPath)
  );

  const prettierConfig = await prettier.resolveConfig(process.cwd());

  if (generateOptions.inferredTypes) {
    const zodInferredTypesFile = coreGenResultData.getInferredTypes(
      getImportPath(generateOptions.inferredTypes, outputPath)
    );
    await outputFile(
      generateOptions.inferredTypes,
      await prettier.format(
        hasExtensions(generateOptions.inferredTypes, JAVASCRIPT_EXTENSIONS)
          ? ts.transpileModule(zodInferredTypesFile, {
              compilerOptions: {
                target: ts.ScriptTarget.Latest,
                module: ts.ModuleKind.ESNext,
                newLine: ts.NewLineKind.LineFeed,
              },
            }).outputText
          : zodInferredTypesFile,
        { parser: "babel-ts", ...prettierConfig }
      )
    );
  }

  const output = outputPath.replace(process.cwd(), "").slice(1);
  if (hasExtensions(output, JAVASCRIPT_EXTENSIONS)) {
    await outputFile(
      outputPath,
      await prettier.format(
        ts.transpileModule(zodSchemasFile, {
          compilerOptions: {
            target: ts.ScriptTarget.Latest,
            module: ts.ModuleKind.ESNext,
            newLine: ts.NewLineKind.LineFeed,
          },
        }).outputText,
        { parser: "babel-ts", ...prettierConfig }
      )
    );
  } else {
    await outputFile(
      outputPath,
      await prettier.format(zodSchemasFile, {
        parser: "babel-ts",
        ...prettierConfig,
      })
    );
  }
}
