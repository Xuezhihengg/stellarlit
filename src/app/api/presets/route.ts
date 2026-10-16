import { NextResponse } from "next/server";

import { BUILTIN_PRESETS } from "@/server/relations/presets";

export const dynamic = "force-dynamic";

/** 内置关系预设。设置页拿到它作为「恢复默认」的基准。 */
export function GET() {
  return NextResponse.json({ presets: BUILTIN_PRESETS });
}
