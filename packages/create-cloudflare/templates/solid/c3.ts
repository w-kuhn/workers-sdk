import { logRaw, updateStatus } from "@cloudflare/cli";
import { blue } from "@cloudflare/cli/colors";
import { transformFile } from "helpers/codemod";
import { runFrameworkGenerator } from "helpers/command";
import { compatDateFlag, usesTypescript } from "helpers/files";
import { detectPackageManager } from "helpers/packages";
import * as recast from "recast";
import type { TemplateConfig } from "../../src/templates";
import type { C3Context } from "types";

const { npm } = detectPackageManager();

const generate = async (ctx: C3Context) => {
	// Run the create-solid command
	// -s flag forces solid-start
	await runFrameworkGenerator(ctx, ["-p", ctx.project.name, "-s"]);

	logRaw("");
};

const configure = async (ctx: C3Context) => {
	usesTypescript(ctx);
	const filePath = `app.config.${usesTypescript(ctx) ? "ts" : "js"}`;

	updateStatus(`Updating configuration in ${blue(filePath)}`);

	transformFile(filePath, {
		visitCallExpression: function (n) {
			const callee = n.node.callee as recast.types.namedTypes.Identifier;
			if (callee.name !== "defineConfig") {
				return this.traverse(n);
			}

			const b = recast.types.builders;
			n.node.arguments = [
				b.objectExpression([
					b.objectProperty(
						b.identifier("server"),
						b.objectExpression([
							b.objectProperty(
								b.identifier("preset"),
								b.stringLiteral("cloudflare-pages")
							),
							b.objectProperty(
								b.identifier("rollupConfig"),
								b.objectExpression([
									b.objectProperty(
										b.identifier("external"),
										b.arrayExpression([b.stringLiteral("node:async_hooks")])
									),
								])
							),
						])
					),
				]),
			];

			return false;
		},
	});
};

const config: TemplateConfig = {
	configVersion: 1,
	id: "solid",
	displayName: "Solid",
	platform: "pages",
	generate,
	configure,
	transformPackageJson: async () => ({
		scripts: {
			preview: `${npm} run build && npx wrangler pages dev dist ${await compatDateFlag()} --compatibility-flag nodejs_compat`,
			deploy: `${npm} run build && wrangler pages deploy ./dist`,
		},
	}),
	compatibilityFlags: ["nodejs_compat"],
	devScript: "dev",
	deployScript: "deploy",
	previewScript: "preview",
};
export default config;
