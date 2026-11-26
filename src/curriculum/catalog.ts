import type { CourseContent } from "../contracts/activity-types.js";
import type { ChatMaterialOption } from "../contracts/chat.js";

export interface PublishedDiscussion extends ChatMaterialOption {
  readings?: { text: string; sourceIds: string[] }[];
  practiceVersion?: string;
}

const memoirContent = {
  title: "钟楼旁的回忆",
  goal: "用原文说明作者亲眼见到了什么，区分亲历与转述。",
  prompt: "哪件事是作者亲眼见到的？哪句话能支持你的判断？",
  materials: [{
    id: "bell-tower", label: "回忆录摘录（教学虚构）",
    text: "我站在钟楼旁，亲眼看见石阶上亮起一盏灯。后来同伴告诉我，街另一头也同时点了灯。",
  }],
  clarifications: [{
    terms: ["摘录", "引文"], text: "摘录时照录材料中的原话，再用自己的话说明理由。",
  }],
} satisfies CourseContent;

export const memoirCourse = {
  version: "memoir-source.v1",
  publicContent: memoirContent,
  privateContent: {
    hints: ["留意作者怎样说明每条消息的来源。"],
  },
};

export const publishedCourses = [memoirCourse];

export const publishedDiscussions: PublishedDiscussion[] = [
  {
    version: "ferry-notes.v1", title: "渡口的冬日见闻",
    question: "根据这段回忆，可以确定作者亲眼见过渡口停航吗？",
    sources: [{ id: "ferry-memory", label: "回忆录摘录（教学虚构）", text: "姨母常说，那年的渡口一入冬便停航。" }],
    supplements: [{ id: "ferry-diary", label: "补充日记（教学虚构）", text: "我翻出自己的日记，腊月初八写着：我到渡口时，船还在载客。" }],
    readings: [
      { text: "作者转述了姨母的说法。作者是否亲自到过渡口，这段回忆没有交代。", sourceIds: ["ferry-memory"] },
      { text: "日记记下了作者腊月初八到过渡口的亲历。那天船仍在载客，因此姨母关于整个冬天的说法需要核实。其他日期的航行情况仍未知。", sourceIds: ["ferry-memory", "ferry-diary"] },
    ],
    practiceVersion: memoirCourse.version,
  },
];
