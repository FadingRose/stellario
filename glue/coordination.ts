import { tool } from "@opencode-ai/plugin"
import { getCoordinationToolDefs } from "stellario/defs/coordination"

const defs = getCoordinationToolDefs()

export const taskboard_plan     = tool(defs.taskboard_plan)
export const taskboard_claim    = tool(defs.taskboard_claim)
export const taskboard_update   = tool(defs.taskboard_update)
export const taskboard_complete = tool(defs.taskboard_complete)
export const taskboard_board    = tool(defs.taskboard_board)
export const taskboard_lock     = tool(defs.taskboard_lock)
export const taskboard_unlock   = tool(defs.taskboard_unlock)
