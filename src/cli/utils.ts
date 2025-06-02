import { parse } from "path";
import { Config, InputOutputMapping, TsToZodConfig } from "../config";

/**
 * Validate if the file extension is ts or tsx.
 *
 * @param path relative path
 * @param extensions list of allowed extensions
 * @returns true if the extension is valid
 */
export const hasExtensions = (path: string, extensions: string[]) => {
  const { ext } = parse(path);
  return extensions.includes(ext);
};

export const getInputOutputMappings = (
  config: TsToZodConfig | undefined
): InputOutputMapping[] => {
  if (!config) {
    return [];
  }

  if (Array.isArray(config)) {
    return config.map((c) => {
      const { input, output, getSchemaName } = c;
      return { input, output, getSchemaName };
    });
  }

  const { input, output, getSchemaName } = config as Config;
  return [{ input, output, getSchemaName }];
};
