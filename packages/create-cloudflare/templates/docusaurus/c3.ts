import { runFrameworkGenerator } from "helpers/command";
import { detectPackageManager } from "helpers/packages";
import type { TemplateConfig } from "../../src/templates";
import type { C3Context } from "types";

const { npm } = detectPackageManager();

const generate = async (ctx: C3Context) => {
	await runFrameworkGenerator(ctx, [ctx.project.name, "classic"]);
};

const config: TemplateConfig = {
	configVersion: 1,
	id: "docusaurus",
	platform: "pages",
	displayName: "Docusaurus",
	generate,
	transformPackageJson: async () => ({
		scripts: {
			deploy: `${npm} run build && wrangler pages deploy ./build`,
		},
	}),
	devScript: "start",
	deployScript: "deploy",
};
export default config;
