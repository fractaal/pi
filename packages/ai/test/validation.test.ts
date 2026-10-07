import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import type { JsonValue, Tool, ToolCall } from "../src/types.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

function createToolCallWithPlainSchema(
	schema: Tool["parameters"],
	value: unknown,
): {
	tool: Tool;
	toolCall: ToolCall;
} {
	const tool: Tool = {
		name: "echo",
		description: "Echo tool",
		parameters: {
			type: "object",
			properties: {
				value: schema,
			},
			required: ["value"],
		} as Tool["parameters"],
	};

	const toolCall: ToolCall = {
		type: "toolCall",
		id: "tool-1",
		name: "echo",
		arguments: { value: value as JsonValue },
	};

	return { tool, toolCall };
}

function validationIssues(tool: Tool, args: Record<string, unknown>): string[] {
	try {
		validateToolArguments(tool, {
			type: "toolCall",
			id: "tool-1",
			name: tool.name,
			arguments: args as ToolCall["arguments"],
		});
	} catch (error) {
		const message = (error as Error).message;
		return message
			.split("\n\nReceived arguments")[0]
			.split("\n")
			.filter((line) => line.startsWith("  - "))
			.map((line) => line.slice(4));
	}
	throw new Error("expected validation to fail");
}

// Shaped like an MCP management tool: one `change` argument whose variants are told apart by `operation`.
const changeTool: Tool = {
	name: "apply_change",
	description: "Apply one change",
	parameters: {
		type: "object",
		properties: {
			change: {
				anyOf: [
					{
						type: "object",
						properties: {
							operation: { const: "create", type: "string" },
							request_id: { type: "string" },
							name: { type: "string", pattern: "^[a-z-]+$" },
						},
						required: ["operation", "request_id", "name"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							operation: { const: "provision", type: "string" },
							request_id: { type: "string" },
							revision: { type: "integer" },
						},
						required: ["operation", "request_id", "revision"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: { operation: { const: "retry", type: "string" }, run_id: { type: "string" } },
						required: ["operation", "run_id"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							operation: { const: "save_product", type: "string" },
							product: {
								type: "object",
								properties: {
									slug: { $ref: "#/properties/change/anyOf/0/properties/name" },
									incident: {
										type: "object",
										properties: { channel: { type: "string" }, frontend: { type: "object" } },
										required: ["frontend"],
										additionalProperties: false,
									},
								},
								required: ["slug", "incident"],
								additionalProperties: false,
							},
						},
						required: ["operation", "product"],
						additionalProperties: false,
					},
					{
						type: "object",
						properties: {
							operation: { const: "save_grant", type: "string" },
							roles: { $ref: "#/$defs/rolesByEnvironment" },
						},
						required: ["operation", "roles"],
						additionalProperties: false,
					},
				],
			},
		},
		required: ["change"],
		additionalProperties: false,
		$defs: {
			rolesByEnvironment: {
				type: "object",
				additionalProperties: { type: "array", items: { type: "string", pattern: "^roles/" } },
			},
		},
	} as Tool["parameters"],
};

describe("validateToolArguments", () => {
	it("still validates when Function constructor is unavailable", () => {
		const originalFunction = globalThis.Function;
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				count: Type.Number(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { count: "42" as unknown as number },
		};

		globalThis.Function = (() => {
			throw new EvalError("Code generation from strings disallowed for this context");
		}) as unknown as FunctionConstructor;

		try {
			expect(validateToolArguments(tool, toolCall)).toEqual({ count: 42 });
		} finally {
			globalThis.Function = originalFunction;
		}
	});

	it("coerces serialized plain JSON schemas with AJV-compatible primitive rules", () => {
		const passingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
			expected: unknown;
		}> = [
			{ schema: { type: "number" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "number" } as Tool["parameters"], input: true, expected: 1 },
			{ schema: { type: "number" } as Tool["parameters"], input: null, expected: 0 },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42", expected: 42 },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "true", expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "false", expected: false },
			{ schema: { type: "boolean" } as Tool["parameters"], input: 1, expected: true },
			{ schema: { type: "boolean" } as Tool["parameters"], input: 0, expected: false },
			{ schema: { type: "string" } as Tool["parameters"], input: null, expected: "" },
			{ schema: { type: "string" } as Tool["parameters"], input: true, expected: "true" },
			{ schema: { type: "null" } as Tool["parameters"], input: "", expected: null },
			{ schema: { type: "null" } as Tool["parameters"], input: 0, expected: null },
			{ schema: { type: "null" } as Tool["parameters"], input: false, expected: null },
			{
				schema: { type: ["number", "string"] } as Tool["parameters"],
				input: "1",
				expected: "1",
			},
			{
				schema: { type: ["boolean", "number"] } as Tool["parameters"],
				input: "1",
				expected: 1,
			},
		];

		for (const testCase of passingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(validateToolArguments(tool, toolCall)).toEqual({ value: testCase.expected });
		}
	});

	it("treats null as omission for optional non-nullable properties", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				path: Type.String(),
				offset: Type.Optional(Type.Number()),
				nullable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
				metadata: Type.Object({ enabled: Type.Optional(Type.Boolean()) }),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { path: "file.txt", offset: null, nullable: null, metadata: { enabled: null } },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({
			path: "file.txt",
			nullable: null,
			metadata: {},
		});
	});

	it("preserves optional nulls whose referenced schema is nullable", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: {
				type: "object",
				properties: { value: { $ref: "#/$defs/value" } },
				$defs: { value: { anyOf: [{ type: "number" }, { type: "null" }] } },
			} as Tool["parameters"],
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { value: null },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	it("preserves a value that already matches a nullable union arm", () => {
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				value: Type.Union([Type.Number(), Type.Null()]),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { value: null },
		};

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	it("preserves a value that already matches a oneOf nullable union arm", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema(
			{ oneOf: [{ type: "number" }, { type: "null" }] } as Tool["parameters"],
			null,
		);

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	it("still coerces nullable unions when the original value does not match any arm", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema(
			{ anyOf: [{ type: "number" }, { type: "null" }] } as Tool["parameters"],
			"42",
		);

		expect(validateToolArguments(tool, toolCall)).toEqual({ value: 42 });
	});

	it("accepts null for nullable array schemas with items", () => {
		const { tool, toolCall } = createToolCallWithPlainSchema(
			{ type: ["array", "null"], items: { type: "string" } } as Tool["parameters"],
			null,
		);
		// The CSP test above selects TypeBox's process-wide interpreted fallback, so exercise the generated validator explicitly.
		const generatedCheck = new Function(Compile(tool.parameters).Code())() as (value: unknown) => boolean;

		expect(generatedCheck(toolCall.arguments)).toBe(true);
		expect(validateToolArguments(tool, toolCall)).toEqual({ value: null });
	});

	it("rejects invalid coercions for serialized plain JSON schemas", () => {
		const failingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
		}> = [
			{ schema: { type: "boolean" } as Tool["parameters"], input: "1" },
			{ schema: { type: "boolean" } as Tool["parameters"], input: "0" },
			{ schema: { type: "null" } as Tool["parameters"], input: "null" },
			{ schema: { type: "integer" } as Tool["parameters"], input: "42.1" },
		];

		for (const testCase of failingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
		}
	});

	it("reports only the problems of the union variant the arguments select", () => {
		const issues = validationIssues(changeTool, {
			change: {
				operation: "save_product",
				product: { slug: "css-fms", incident: { channel: "ops" }, frontend: { mode: "observe" } },
			},
		});

		expect(issues).toEqual([
			'change.product: unexpected property "frontend"',
			'change.product.incident: missing required property "frontend"',
		]);
	});

	it("lists the allowed values when no union variant matches the discriminator", () => {
		const issues = validationIssues(changeTool, { change: { operation: "save_widget" } });

		expect(issues).toEqual([
			'change.operation: must be one of "create", "provision", "retry", "save_product", "save_grant"',
		]);
	});

	it("explains an invalid value inside a map instead of rejecting its key", () => {
		const issues = validationIssues(changeTool, {
			change: { operation: "save_grant", roles: { dev: ["roles/run.admin", "run.invoker"] } },
		});

		expect(issues).toEqual(['change.roles.dev.1: must match pattern "^roles/"']);
	});

	it("reports every problem, not only the first eight", () => {
		const fields = Array.from({ length: 10 }, (_, index) => `field${index}`);
		const tool: Tool = {
			name: "many",
			description: "Many fields",
			parameters: {
				type: "object",
				properties: Object.fromEntries(fields.map((field) => [field, { type: "integer" }])),
			} as Tool["parameters"],
		};

		const issues = validationIssues(tool, Object.fromEntries(fields.map((field) => [field, "not a number"])));

		expect(issues.map((issue) => issue.split(":")[0])).toEqual(fields);
	});
});
