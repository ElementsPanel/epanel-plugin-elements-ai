export interface PluginSettingField {
  key?: string;
  type: string;
  title?: string;
  min?: number;
  max?: number;
  required?: boolean;
  options?: Array<{ value: unknown }>;
  fields?: PluginSettingField[];
  maxItems?: number;
}

/** Validate the form contract on the server before invoking plugin-owned validation. */
export function validatePluginSettings(
  fields: readonly PluginSettingField[],
  values: unknown
): asserts values is Record<string, unknown> {
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error("Invalid plugin settings.");
  const input = values as Record<string, unknown>;
  for (const field of fields) {
    if (!field.key || field.type === "link") continue;
    const value = input[field.key];
    if (value === undefined || value === null) {
      if (field.required) throw new Error(`${field.title || field.key}: required`);
      continue;
    }
    if (field.type === "list") {
      if (!Array.isArray(value) || value.length > (field.maxItems ?? 100))
        throw new Error(`${field.title || field.key}: invalid list`);
      for (const item of value) validatePluginSettings(field.fields || [], item);
      continue;
    }
    const valid =
      field.type === "number"
        ? typeof value === "number" &&
          Number.isFinite(value) &&
          (field.min === undefined || value >= field.min) &&
          (field.max === undefined || value <= field.max)
        : field.type === "boolean"
        ? typeof value === "boolean"
        : field.type === "select"
        ? field.options?.some((option) => option.value === value)
        : typeof value === "string";
    if (!valid) throw new Error(`${field.title || field.key}: invalid value`);
  }
}
