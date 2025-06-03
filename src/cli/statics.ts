import { Args, Flags } from "@oclif/core";

export const createFlags = (
  tsToZodConfigFileName: string,
  configKeys: string[],
  haveMultiConfig: boolean
) => ({
  version: Flags.version({ char: "v" }),
  help: Flags.help({ char: "h" }),
  keepComments: Flags.boolean({
    char: "k",
    description: "Keep parameters comments",
  }),
  init: Flags.boolean({
    char: "i",
    description: `Create a ${tsToZodConfigFileName} file`,
  }),
  skipParseJSDoc: Flags.boolean({
    default: false,
    description: "Skip the creation of zod validators from JSDoc annotations",
  }),
  skipValidation: Flags.boolean({
    default: false,
    description: "Skip the validation step (not recommended)",
  }),
  inferredTypes: Flags.string({
    description: "Path of z.infer<> types file",
  }),
  watch: Flags.boolean({
    char: "w",
    default: false,
    description: "Watch input file(s) for changes and re-run related task",
  }),
  // -- Multi config flags --
  config: Flags.string({
    char: "c",
    options: configKeys,
    description: "Execute one config",
    hidden: !haveMultiConfig,
  }),
  all: Flags.boolean({
    char: "a",
    default: false,
    description: "Execute all configs",
    hidden: !haveMultiConfig,
  }),
  generateNested: Flags.boolean({
    default: false,
    description:
      "EXPERIMENTAL: Automatically discover and generate schemas for local imports. Use with a single input file argument only.",
  }),
  maxDepth: Flags.integer({
    description: "Max recursion depth for --generateNested.",
    default: 5,
  }),
});

export const argsStatic = {
  input: Args.file({
    description: "input file (typescript)",
  }),
  output: Args.file({
    description: "output file (zod schemas)",
  }),
};
