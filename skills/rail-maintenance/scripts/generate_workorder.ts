#!/usr/bin/env node
/**
 * 轨交检修工单生成器 — OpenClaw rail-maintenance Skill
 * 输入: JSON 参数（argv[2] 或 stdin），输出: 标准化工单 JSON
 * 零依赖，Node >= 20（.ts 由 Node 24 原生类型剥离执行）
 */

interface WorkOrderInput {
  line?: string;
  location?: string;
  equipmentType?: string;
  equipmentId?: string;
  maintenanceType?: string;
  description?: string;
  priority?: string;
  assignee?: string;
}

interface WorkOrder {
  workOrderId: string;
  line: string;
  location: string;
  equipment: { type: string; id: string };
  maintenanceType: string;
  priority: string;
  riskLevel: "低" | "中" | "高";
  safetyMeasures: string[];
  requiredCertifications: string[];
  assignee: string;
  status: string;
  createdAt: string;
  planWindow: string;
  description: string;
}

const SAFETY_RULES: Record<string, { measures: string[]; certs: string[] }> = {
  道岔: {
    measures: ["断开转辙机安全接点并加锁", "加装钩锁器防止转换", "设置防护员，天窗点内作业"],
    certs: ["轨道线路工", "信号工（配合）"],
  },
  接触网: {
    measures: ["接触网停电、验电、挂接地线", "高空作业系安全带", "绝缘工具检测合格"],
    certs: ["接触网工", "高压电工证"],
  },
  信号机: {
    measures: ["断开信号电源并加锁登记", "防止误动、作业前联系信号楼", "天窗点内作业"],
    certs: ["信号工"],
  },
  轨道: {
    measures: ["天窗点内作业", "防护员到位、通讯畅通", "绝缘防护用品佩戴"],
    certs: ["轨道线路工"],
  },
  供电: {
    measures: ["双电源确认、挂牌上锁（LOTO）", "验电后作业", "专人监护"],
    certs: ["高压电工证"],
  },
  车辆: {
    measures: ["库内作业、接触网停电或隔离开关断开", "设置防溜措施", "作业端挂警示灯"],
    certs: ["车辆检修工"],
  },
};

const EQUIPMENT_TYPES = Object.keys(SAFETY_RULES);
const PRIORITIES = ["紧急", "高", "中", "低"];

function usage(): never {
  console.error("用法: generate_workorder.ts '<json参数>'");
  console.error(`可选设备类型: ${EQUIPMENT_TYPES.join(" / ")}`);
  console.error(`可选优先级: ${PRIORITIES.join(" / ")}`);
  process.exit(1);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function main(): void {
  const rawArg = process.argv[2];
  let input: WorkOrderInput;

  if (rawArg) {
    try {
      input = JSON.parse(rawArg) as WorkOrderInput;
    } catch (e) {
      console.error("参数不是合法 JSON: " + (e as Error).message);
      usage();
    }
  } else {
    console.error("缺少 JSON 参数");
    usage();
  }

  const equipmentType = input.equipmentType && SAFETY_RULES[input.equipmentType]
    ? input.equipmentType
    : "轨道";
  if (input.equipmentType && !SAFETY_RULES[input.equipmentType]) {
    console.error(`警告: 未知设备类型 "${input.equipmentType}"，已回退为「轨道」。支持: ${EQUIPMENT_TYPES.join("/")}`);
  }

  let priority = input.priority && PRIORITIES.includes(input.priority) ? input.priority : "中";
  let maintenanceType = input.maintenanceType || "日常检修";

  // 故障修优先级自动提升一档
  if (maintenanceType === "故障修") {
    const idx = PRIORITIES.indexOf(priority);
    priority = PRIORITIES[Math.max(0, idx - 1)];
  }
  // 影响行车的紧急描述直接置紧急
  if (input.description && /行车|中断|挤岔|断轨|跳闸/.test(input.description)) {
    priority = "紧急";
  }

  const rules = SAFETY_RULES[equipmentType];
  const riskLevel: WorkOrder["riskLevel"] =
    priority === "紧急" ? "高" : priority === "高" ? "高" : priority === "中" ? "中" : "低";

  const now = new Date();
  const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const seq = String(Math.floor(Math.random() * 900) + 100);

  const order: WorkOrder = {
    workOrderId: `WO-${dateStr}-${seq}`,
    line: input.line || "未知线路",
    location: input.location || "待补充",
    equipment: {
      type: equipmentType,
      id: input.equipmentId || `${equipmentType}-AUTO-${seq}`,
    },
    maintenanceType,
    priority,
    riskLevel,
    safetyMeasures: rules.measures,
    requiredCertifications: rules.certs,
    assignee: input.assignee || "待指派",
    status: "待派发",
    createdAt: now.toISOString(),
    planWindow: priority === "紧急" ? "立即申请抢修天窗" : "建议纳入下一维修天窗（夜间 00:30-04:30）",
    description: input.description || "",
  };

  console.log(JSON.stringify(order, null, 2));
}

main();
