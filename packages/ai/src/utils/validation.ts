import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Settings } from "typebox/system";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

interface JsonSchemaObject {
	type?: string | string[];
	properties?: Record<string, JsonSchemaObject>;
	required?: string[];
	items?: JsonSchemaObject | JsonSchemaObject[];
	additionalProperties?: boolean | JsonSchemaObject;
	allOf?: JsonSchemaObject[];
	anyOf?: JsonSchemaObject[];
	oneOf?: JsonSchemaObject[];
}

function getSchemaTypes(schema: JsonSchemaObject): string[] {
	if (typeof schema.type === "string") {
		return [schema.type];
	}
	if (Array.isArray(schema.type)) {
		return schema.type.filter((type): type is string => typeof type === "string");
	}
	return [];
}

function matchesJsonType(value: unknown, type: string): boolean {
	switch (type) {
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		default:
			return false;
	}
}

function getSubSchemaValidator(schema: JsonSchemaObject): ReturnType<typeof Compile> | undefined {
	try {
		return getValidator(schema as Tool["parameters"]);
	} catch {
		return undefined;
	}
}

function coercePrimitiveByType(value: unknown, type: string): unknown {
	switch (type) {
		case "number": {
			if (value === null) {
				return 0;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) {
					return parsed;
				}
			}
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "integer": {
			if (value === null) {
				return 0;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isInteger(parsed)) {
					return parsed;
				}
			}
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "boolean": {
			if (value === null) {
				return false;
			}
			if (typeof value === "string") {
				if (value === "true") {
					return true;
				}
				if (value === "false") {
					return false;
				}
			}
			if (typeof value === "number") {
				if (value === 1) {
					return true;
				}
				if (value === 0) {
					return false;
				}
			}
			return value;
		}
		case "string": {
			if (value === null) {
				return "";
			}
			if (typeof value === "number" || typeof value === "boolean") {
				return String(value);
			}
			return value;
		}
		case "null": {
			if (value === "" || value === 0 || value === false) {
				return null;
			}
			return value;
		}
		default:
			return value;
	}
}

function applySchemaObjectCoercion(value: Record<string, unknown>, schema: JsonSchemaObject): void {
	const properties = schema.properties;
	const definedKeys = new Set<string>(properties ? Object.keys(properties) : []);

	if (properties) {
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (!(key in value)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(value[key], propertySchema);
		}
	}

	if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
		for (const [key, propertyValue] of Object.entries(value)) {
			if (definedKeys.has(key)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties);
		}
	}
}

function applySchemaArrayCoercion(value: unknown[], schema: JsonSchemaObject): void {
	if (Array.isArray(schema.items)) {
		for (let index = 0; index < value.length; index++) {
			const itemSchema = schema.items[index];
			if (!itemSchema) {
				continue;
			}
			value[index] = coerceWithJsonSchema(value[index], itemSchema);
		}
		return;
	}

	if (schema.items && typeof schema.items === "object") {
		for (let index = 0; index < value.length; index++) {
			value[index] = coerceWithJsonSchema(value[index], schema.items);
		}
	}
}

function coerceWithUnionSchema(value: unknown, schemas: JsonSchemaObject[]): unknown {
	for (const schema of schemas) {
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(value)) {
			return value;
		}
	}

	for (const schema of schemas) {
		const candidate = structuredClone(value);
		const coerced = coerceWithJsonSchema(candidate, schema);
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(coerced)) {
			return coerced;
		}
	}
	return value;
}

function coerceWithJsonSchema(value: unknown, schema: JsonSchemaObject): unknown {
	let nextValue = value;

	if (Array.isArray(schema.allOf)) {
		for (const nested of schema.allOf) {
			nextValue = coerceWithJsonSchema(nextValue, nested);
		}
	}

	if (Array.isArray(schema.anyOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
	}

	if (Array.isArray(schema.oneOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
	}

	const schemaTypes = getSchemaTypes(schema);
	const matchesUnionMember =
		schemaTypes.length > 1 && schemaTypes.some((schemaType) => matchesJsonType(nextValue, schemaType));
	if (schemaTypes.length > 0 && !matchesUnionMember) {
		for (const schemaType of schemaTypes) {
			const candidate = coercePrimitiveByType(nextValue, schemaType);
			if (candidate !== nextValue) {
				nextValue = candidate;
				break;
			}
		}
	}

	if (
		schemaTypes.includes("object") &&
		typeof nextValue === "object" &&
		nextValue !== null &&
		!Array.isArray(nextValue)
	) {
		applySchemaObjectCoercion(nextValue as Record<string, unknown>, schema);
	}

	if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
		applySchemaArrayCoercion(nextValue, schema);
	}

	return nextValue;
}

function normalizeOptionalNulls(value: unknown, schema: JsonSchemaObject): void {
	if (Array.isArray(value)) {
		if (Array.isArray(schema.items)) {
			for (let index = 0; index < value.length; index++) {
				const itemSchema = schema.items[index];
				if (itemSchema) normalizeOptionalNulls(value[index], itemSchema);
			}
		} else if (schema.items) {
			for (const item of value) normalizeOptionalNulls(item, schema.items);
		}
		return;
	}
	if (typeof value !== "object" || value === null || !schema.properties) return;

	const object = value as Record<string, unknown>;
	const required = new Set(schema.required ?? []);
	for (const [key, propertySchema] of Object.entries(schema.properties)) {
		if (!(key in object)) continue;
		if (
			object[key] === null &&
			!required.has(key) &&
			typeof (propertySchema as { $ref?: unknown }).$ref !== "string" &&
			getSubSchemaValidator(propertySchema)?.Check(null) === false
		) {
			delete object[key];
		} else {
			normalizeOptionalNulls(object[key], propertySchema);
		}
	}
}

function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
	const key = schema as object;
	const cached = validatorCache.get(key);
	if (cached) {
		return cached;
	}
	const validator = Compile(schema);
	validatorCache.set(key, validator);
	return validator;
}

interface ValidationIssue {
	instancePath: string;
	message: string;
}

const dereferencedSchemaCache = new WeakMap<object, JsonSchemaObject>();

function decodePointerSegments(pointer: string): string[] {
	return pointer
		.split("/")
		.slice(1)
		.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function resolvePointer(root: unknown, pointer: string): unknown {
	if (pointer !== "#" && !pointer.startsWith("#/")) return undefined;
	let node = root;
	for (const segment of decodePointerSegments(pointer.slice(1))) {
		if (typeof node !== "object" || node === null) return undefined;
		node = (node as Record<string, unknown>)[segment];
	}
	return node;
}

/**
 * Inlines local `$ref`s so that every error's schema path points into the tool schema itself. TypeBox reports
 * errors inside a referenced schema relative to the reference target, which hides which union branch they
 * belong to. Recursive references are left in place.
 */
function dereferenceSchema(schema: Tool["parameters"]): JsonSchemaObject {
	const cached = dereferencedSchemaCache.get(schema);
	if (cached) return cached;
	const visit = (node: unknown, activeRefs: ReadonlySet<string>): unknown => {
		if (Array.isArray(node)) return node.map((item) => visit(item, activeRefs));
		if (typeof node !== "object" || node === null) return node;
		const { $ref: ref, ...rest } = node as Record<string, unknown>;
		const target = typeof ref === "string" && !activeRefs.has(ref) ? resolvePointer(schema, ref) : undefined;
		const entries = Object.entries(rest).map(([key, value]) => [key, visit(value, activeRefs)]);
		if (target === undefined) return Object.fromEntries(ref === undefined ? entries : [["$ref", ref], ...entries]);
		const resolved = visit(target, new Set([...activeRefs, ref as string]));
		return entries.length === 0 ? resolved : { ...(resolved as object), ...Object.fromEntries(entries) };
	};
	const dereferenced = (JSON.stringify(schema).includes('"$ref"') ? visit(schema, new Set()) : schema) as JsonSchemaObject;
	dereferencedSchemaCache.set(schema, dereferenced);
	return dereferenced;
}

// TypeBox stops collecting errors at Settings.maxErrors (8 by default). A union reports every branch in order,
// so the cap could hide the only branch the arguments were meant for.
function collectErrors(validator: ReturnType<typeof Compile>, value: unknown): TLocalizedValidationError[] {
	const { maxErrors } = Settings.Get();
	Settings.Set({ maxErrors: Number.POSITIVE_INFINITY });
	try {
		return validator.Errors(value);
	} finally {
		Settings.Set({ maxErrors });
	}
}

/**
 * A failed union reports the errors of every branch. When branches are told apart by a constant property, such
 * as `operation: "save_product"`, keep only the errors of the branches the arguments selected. When no branch
 * matches, report the allowed constants instead of every branch's shape.
 */
function narrowUnionErrors(errors: TLocalizedValidationError[]): TLocalizedValidationError[] {
	let result = errors;
	const unions = errors
		.filter((error) => error.keyword === "anyOf" || error.keyword === "oneOf")
		.sort((left, right) => left.schemaPath.length - right.schemaPath.length);
	for (const union of unions) {
		if (!result.includes(union)) continue;
		const prefix = `${union.schemaPath}/${union.keyword}/`;
		const branchOf = (error: TLocalizedValidationError) =>
			error.schemaPath.startsWith(prefix) ? error.schemaPath.slice(prefix.length).split("/")[0] : undefined;
		const discriminatorErrors = result.filter(
			(error) =>
				(error.keyword === "const" || error.keyword === "enum") &&
				error.schemaPath.startsWith(prefix) &&
				/^\d+\/properties\/[^/]+$/.test(error.schemaPath.slice(prefix.length)),
		);
		if (discriminatorErrors.length === 0) continue;
		const branches = new Set(result.map(branchOf).filter((branch) => branch !== undefined));
		const rejected = new Set(discriminatorErrors.map(branchOf));
		if (rejected.size < branches.size) {
			result = result.filter((error) => error !== union && !rejected.has(branchOf(error)));
			continue;
		}
		const discriminatorPaths = new Set(discriminatorErrors.map((error) => error.instancePath));
		if (discriminatorPaths.size !== 1) continue;
		const allowedValues = discriminatorErrors.flatMap((error) =>
			error.keyword === "const" ? [error.params.allowedValue] : (error.params as { allowedValues: unknown[] }).allowedValues,
		);
		const replacement = {
			keyword: "enum",
			schemaPath: union.schemaPath,
			instancePath: discriminatorErrors[0].instancePath,
			params: { allowedValues },
			message: "",
		} as TLocalizedValidationError;
		result = result.flatMap((error) => (error === union ? [replacement] : branchOf(error) === undefined ? [error] : []));
	}
	return result;
}

function valueAtPointer(value: unknown, pointer: string): unknown {
	let node = value;
	for (const segment of decodePointerSegments(pointer)) {
		if (typeof node !== "object" || node === null) return undefined;
		node = (node as Record<string, unknown>)[segment];
	}
	return node;
}

function quoteList(values: unknown[]): string {
	return values.map((value) => JSON.stringify(value)).join(", ");
}

function describeError(error: TLocalizedValidationError): string {
	switch (error.keyword) {
		case "required": {
			const missing = error.params.requiredProperties;
			return `missing required ${missing.length === 1 ? "property" : "properties"} ${quoteList(missing)}`;
		}
		case "const":
			return `must be ${JSON.stringify(error.params.allowedValue)}`;
		case "enum":
			return `must be one of ${quoteList(error.params.allowedValues)}`;
		default:
			return error.message;
	}
}

/** Explains why `value` fails `schema`, with each issue located at the argument it concerns. */
function explainValidationFailure(schema: JsonSchemaObject, value: unknown, basePath: string): ValidationIssue[] {
	const validator = getSubSchemaValidator(schema);
	if (!validator) return [];
	const issues: ValidationIssue[] = [];
	const errors = narrowUnionErrors(collectErrors(validator, value));
	// Each key an additionalProperties error lists is explained below, so skip TypeBox's per-key errors for them.
	const additionalPropertiesPaths = errors
		.filter((error) => error.keyword === "additionalProperties")
		.map((error) => `${error.schemaPath}/additionalProperties`);
	for (const error of errors) {
		if (additionalPropertiesPaths.some((path) => error.schemaPath === path || error.schemaPath.startsWith(`${path}/`))) {
			continue;
		}
		const instancePath = `${basePath}${error.instancePath}`;
		if (error.keyword !== "additionalProperties") {
			issues.push({ instancePath, message: describeError(error) });
			continue;
		}
		const keys = error.params.additionalProperties;
		const valueSchema = (resolvePointer(schema, error.schemaPath) as JsonSchemaObject | undefined)?.additionalProperties;
		if (typeof valueSchema !== "object") {
			issues.push({
				instancePath,
				message: `unexpected ${keys.length === 1 ? "property" : "properties"} ${quoteList(keys)}`,
			});
			continue;
		}
		// TypeBox names a map entry whose value is invalid as if the key itself were not allowed; explain the value.
		for (const key of keys) {
			const segment = `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
			const entryValue = valueAtPointer(value, `${error.instancePath}${segment}`);
			const entryIssues = explainValidationFailure(valueSchema, entryValue, `${instancePath}${segment}`);
			issues.push(...(entryIssues.length > 0 ? entryIssues : [{ instancePath: `${instancePath}${segment}`, message: "is invalid" }]));
		}
	}
	const seen = new Set<string>();
	return issues.filter((issue) => {
		const key = `${issue.instancePath}\0${issue.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function formatIssuePath(instancePath: string): string {
	return decodePointerSegments(instancePath).join(".") || "root";
}

/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	const args = structuredClone(toolCall.arguments);
	normalizeOptionalNulls(args, tool.parameters as JsonSchemaObject);
	Value.Convert(tool.parameters, args);

	const validator = getValidator(tool.parameters);
	if (!Object.getOwnPropertySymbols(tool.parameters).includes(TYPEBOX_KIND)) {
		const coerced = coerceWithJsonSchema(args, tool.parameters as JsonSchemaObject);
		if (coerced !== args) {
			if (typeof args === "object" && args !== null && typeof coerced === "object" && coerced !== null) {
				for (const key of Object.keys(args)) {
					delete args[key];
				}
				Object.assign(args, coerced);
			} else {
				return validator.Check(coerced) ? coerced : args;
			}
		}
	}

	if (validator.Check(args)) {
		return args;
	}

	const explained = explainValidationFailure(dereferenceSchema(tool.parameters), args, "");
	const issues =
		explained.length > 0
			? explained
			: collectErrors(validator, args).map((error) => ({ instancePath: error.instancePath, message: describeError(error) }));
	const errors =
		issues.map((issue) => `  - ${formatIssuePath(issue.instancePath)}: ${issue.message}`).join("\n") ||
		"Unknown validation error";

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

	throw new Error(errorMessage);
}
