import {
  CustomJSDocFormatTypes,
  InputOutputMapping,
  JSDocTagFilter,
  NameFilter,
} from "../../config";

export interface GenerateProps {
  /**
   * Content of the typescript source file.
   */
  sourceText: string;

  /**
   * Filter on type/interface name.
   */
  nameFilter?: NameFilter;

  /**
   * Filter on JSDocTag.
   */
  jsDocTagFilter?: JSDocTagFilter;

  /**
   * Schema name generator.
   */
  getSchemaName?: (identifier: string) => string;

  /**
   * Keep parameters comments.
   * @default false
   */
  keepComments?: boolean;

  /**
   * Skip the creation of zod validators from JSDoc annotations
   *
   * @default false
   */
  skipParseJSDoc?: boolean;

  /**
   * Path of z.infer<> types file.
   */
  inferredTypes?: string;
  /**
   * Custom JSDoc format types.
   */
  customJSDocFormatTypes?: CustomJSDocFormatTypes;

  /**
   * Map of input/output from config that can
   * be used to automatically handle imports
   */
  inputOutputMappings?: InputOutputMapping[];
}
