/**
 * OpenAlex 的领域/子领域名 → 中文。
 *
 * OpenAlex 只提供英文标签,而"星云标题用英文"会让整片星空读起来像一张
 * 数据库导出表,而不是一张给人看的地图。界面语言应当统一:
 * 论文标题保留原文(那是文献的正式名称,翻译反而有害),
 * 但**领域与前沿是我们自己归纳出来的概念**,用中文命名才是对的。
 *
 * 用静态字典而不是让模型翻译,有三个理由:
 *   1. 这些名字在语料里高度重复,字典覆盖率天然很高;
 *   2. 确定性 —— 同一片星空每次打开,星云的名字必须一模一样;
 *   3. 零成本、零延迟。
 * 查不到的保留英文原文,而不是硬翻成半通不通的中文。
 */

/** 学科大类(field 层) */
const FIELD: Record<string, string> = {
  "Computer Science": "计算机科学",
  "Engineering": "工程学",
  "Mathematics": "数学",
  "Physics and Astronomy": "物理与天文",
  "Medicine": "医学",
  "Biology": "生物学",
  "Chemistry": "化学",
  "Materials Science": "材料科学",
  "Environmental Science": "环境科学",
  "Earth and Planetary Sciences": "地球与行星科学",
  "Social Sciences": "社会科学",
  "Psychology": "心理学",
  "Economics, Econometrics and Finance": "经济与金融",
  "Business, Management and Accounting": "工商管理",
  "Decision Sciences": "决策科学",
  "Neuroscience": "神经科学",
  "Biochemistry, Genetics and Molecular Biology": "生物化学与分子生物学",
  "Agricultural and Biological Sciences": "农业与生物科学",
  "Arts and Humanities": "人文艺术",
  "Health Professions": "健康职业",
  "Nursing": "护理学",
  "Pharmacology, Toxicology and Pharmaceutics": "药理学与毒理学",
  "Immunology and Microbiology": "免疫学与微生物学",
  "Energy": "能源",
  "Chemical Engineering": "化学工程",
  "Multidisciplinary": "交叉学科",
};

/** 子领域(subfield 层)—— 星图上的"研究前沿"标签大多来自这里 */
const SUBFIELD: Record<string, string> = {
  "Artificial Intelligence": "人工智能",
  "Computer Vision and Pattern Recognition": "计算机视觉与模式识别",
  "Computer Networks and Communications": "计算机网络与通信",
  "Software": "软件工程",
  "Information Systems": "信息系统",
  "Computer Graphics and Computer-Aided Design": "计算机图形学与辅助设计",
  "Human-Computer Interaction": "人机交互",
  "Computational Theory and Mathematics": "计算理论与数学",
  "Theoretical Computer Science": "理论计算机科学",
  "Computer Science Applications": "计算机应用",
  "Signal Processing": "信号处理",
  "Hardware and Architecture": "硬件与体系结构",
  "Health Informatics": "健康信息学",
  "Applied Mathematics": "应用数学",
  "Statistics and Probability": "统计与概率",
  "Mathematical Optimization": "数学优化",
  "Numerical Analysis": "数值分析",
  "Discrete Mathematics and Combinatorics": "离散数学与组合数学",
  "Computational Mechanics": "计算力学",
  "Mechanical Engineering": "机械工程",
  "Electrical and Electronic Engineering": "电气与电子工程",
  "Control and Systems Engineering": "控制与系统工程",
  "Biomedical Engineering": "生物医学工程",
  "Robotics": "机器人学",
  "Automotive Engineering": "车辆工程",
  "Aerospace Engineering": "航空航天工程",
  "Industrial and Manufacturing Engineering": "工业与制造工程",
  "Civil and Structural Engineering": "土木与结构工程",
  "Condensed Matter Physics": "凝聚态物理",
  "Quantum Physics": "量子物理",
  "Molecular Biology": "分子生物学",
  "Genetics": "遗传学",
  "Cell Biology": "细胞生物学",
  "Ecology, Evolution, Behavior and Systematics": "生态与进化生物学",
  "Public Health, Environmental and Occupational Health": "公共卫生",
  "Radiology, Nuclear Medicine and Imaging": "影像医学",
  "Neurology": "神经病学",
  "Oncology": "肿瘤学",
  "Linguistics and Language": "语言学",
  "Education": "教育学",
  "Sociology and Political Science": "社会学与政治学",
  "Finance": "金融",
  "Marketing": "市场营销",
  "Management Science and Operations Research": "管理科学与运筹",
  "Renewable Energy, Sustainability and the Environment": "可再生能源与可持续",
  "Materials Chemistry": "材料化学",
  "Physical and Theoretical Chemistry": "物理化学",
  "Inorganic Chemistry": "无机化学",
  "Organic Chemistry": "有机化学",
  "Instrumentation": "仪器科学",
  "Atomic and Molecular Physics, and Optics": "原子分子物理与光学",
  "Fluid Flow and Transfer Processes": "流体与传热",
  "Geometry and Topology": "几何与拓扑",
  "Algebra and Number Theory": "代数与数论",
  "Analysis": "分析学",
};

/**
 * 查表。两级回退:先找子领域,再找大类,查不到就原样返回。
 *
 * 保留英文是刻意的:一个半通不通的中文译名,比英文原名更难理解,
 * 也会让用户怀疑"系统是不是编的"。
 */
export function zhLabel(openalexName: string): string {
  const trimmed = openalexName.trim();
  return SUBFIELD[trimmed] ?? FIELD[trimmed] ?? trimmed;
}
