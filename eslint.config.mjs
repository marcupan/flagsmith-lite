// @ts-check
import tsEsLint from "typescript-eslint";
import { base, api, web, shared, scripts } from "@project/config-lint";

export default tsEsLint.config(...base, ...api, ...web, ...shared, ...scripts);
