import type { ConversationMessage } from "./model.js";

function excerpt(text: string): string {
  const characters = Array.from(text.trim().replace(/\s+/gu, " ").replace(/[。！？；，：.!?;,:]+$/u, ""));
  return characters.length <= 48 ? characters.join("") : characters.slice(0, 47).join("") + "…";
}

const topicChange = /^(?:换个(?:话题|主题|方向)|换(?:成|学)|改学|我?现在想学|我?想改学|我?想换个(?:话题|主题|方向))[，,。\s]*/u;
const topicIntroduction = /^(?:我?想学(?:习)?(?!会)|我?想了解)/u;
const greeting = /^(?:你好|您好|hi|hello|还没想好|不知道学什么)?[!！。?？\s]*$/iu;
const unsure = /零基础|没[有学做]过|从零|不知道|没想好|太难|不会|卡住/u;

function firstStep(goal: string): string {
  if (/阅读|资料|史料|回忆录|原文|文献|文章|读懂/u.test(goal)) {
    return "挑一小段材料，用一句话写下你的理解，再圈出最能支持它的一句原文。哪一点还需要别的材料来确认？";
  }
  if (/做|写|画|拍|弹|演奏|唱|练|制作|编程|设计|操作/u.test(goal)) {
    return "挑一个可以在十分钟内做出的小样，先照自己的办法试一次，留下结果。哪一步最想找个示范来对照？";
  }
  return "挑一个具体例子，先用自己的话解释给没学过的人听。说到哪一步时，你最需要一个例子或一份资料？";
}

export function guideConversation(history: readonly ConversationMessage[]): string {
  const userMessages = history.filter(message => message.role === "user").map(message => message.content.trim());
  let start = 0;
  let topic = "";
  for (const [index, message] of userMessages.entries()) {
    if (greeting.test(topic) || topicChange.test(message) || topicIntroduction.test(message)) {
      start = index;
      topic = excerpt(message.replace(topicChange, "").replace(topicIntroduction, ""));
    }
  }
  const steps = userMessages.slice(start + 1);
  const latest = userMessages[userMessages.length - 1];

  if (greeting.test(topic)) {
    return "最近有没有一件事，让你想知道它是怎么回事，或者想自己做一次？可以从一个问题、一份材料或一项技能说起。";
  }
  if (steps.length === 0) {
    if (/[？?]|为什么|怎么|如何|是什么|什么是/u.test(latest)) {
      return `你带来的问题是“${topic}”。先找一个让你产生这个疑问的例子。你已经能解释哪一部分，卡在哪里？`;
    }
    return `关于“${topic}”，你最希望自己能独立做哪件事？可以说一个你打算用到它的场景。`;
  }
  if (unsure.test(latest)) {
    return `我们可以把“${topic}”缩小一点。找一个你见过的例子，先指出其中一个你能认出来的细节。关于这个细节，你最想问什么？`;
  }
  const goalIndex = steps.findIndex(step => !unsure.test(step));
  const goal = excerpt(steps[goalIndex]);
  if (goalIndex === steps.length - 1 || /下一步|怎么开始|如何开始|计划|第一步/u.test(latest)) {
    return `围绕“${goal}”，可以先试一次。\n\n${firstStep(topic + goal)}`;
  }
  if (/完成|做到了|做完|懂了|明白了|学会了/u.test(latest)) {
    return `回到“${goal}”，换一个没见过的例子，先独立试一遍。你会用什么结果判断自己已经学会了？`;
  }
  return `你刚才提到“${excerpt(latest)}”。回到“${goal}”，你已经能独立完成哪一部分？选最不确定的一步，下次只练这一点。`;
}
