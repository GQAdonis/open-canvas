import { useState } from "react";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { useToast } from "../use-toast";
import { createClient } from "../utils";
import {
  ArtifactLengthOptions,
  ArtifactType,
  ArtifactV3,
  Highlight,
  LanguageOptions,
  ProgrammingLanguageOptions,
  ReadingLevelOptions,
  ArtifactToolResponse,
  RewriteArtifactMetaToolResponse,
  TextHighlight,
} from "@/types";
import { parsePartialJson } from "@langchain/core/output_parsers";
import { useRuns } from "../useRuns";
import { reverseCleanContent } from "@/lib/normalize_string";
import { Thread } from "@langchain/langgraph-sdk";
import { setCookie } from "@/lib/cookies";
import { THREAD_ID_COOKIE_NAME } from "@/constants";
import {
  convertToArtifactV3,
  createNewGeneratedArtifactFromTool,
  replaceOrInsertMessageChunk,
  updateHighlightedCode,
  updateHighlightedMarkdown,
  updateRewrittenArtifact,
} from "./utils";
import {
  isArtifactCodeContent,
  isArtifactMarkdownContent,
  isDeprecatedArtifactType,
} from "@/lib/artifact_content_types";
// import { DEFAULT_ARTIFACTS, DEFAULT_MESSAGES } from "@/lib/dummy";

export interface GraphInput {
  selectedArtifactId?: string;
  regenerateWithEmojis?: boolean;
  readingLevel?: ReadingLevelOptions;
  artifactLength?: ArtifactLengthOptions;
  language?: LanguageOptions;
  messages?: Record<string, any>[];
  highlighted?: Highlight;
  addComments?: boolean;
  addLogs?: boolean;
  portLanguage?: ProgrammingLanguageOptions;
  fixBugs?: boolean;
  customQuickActionId?: string;
}

function removeCodeBlockFormatting(text: string): string {
  if (!text) return text;
  // Regular expression to match code blocks
  const codeBlockRegex = /^```[\w-]*\n([\s\S]*?)\n```$/;

  // Check if the text matches the code block pattern
  const match = text.match(codeBlockRegex);

  if (match) {
    // If it matches, return the content inside the code block
    return match[1].trim();
  } else {
    // If it doesn't match, return the original text
    return text;
  }
}

export interface UseGraphInput {
  userId: string;
  threadId: string | undefined;
  assistantId: string | undefined;
}

export function useGraph(useGraphInput: UseGraphInput) {
  const { toast } = useToast();
  const { shareRun } = useRuns();
  const [messages, setMessages] = useState<BaseMessage[]>([]);
  const [artifact, setArtifact] = useState<ArtifactV3>();
  const [selectedBlocks, setSelectedBlocks] = useState<TextHighlight>();
  const [isStreaming, setIsStreaming] = useState(false);

  const clearState = () => {
    setMessages([]);
    setArtifact(undefined);
  };

  const streamMessageV2 = async (params: GraphInput) => {
    if (!useGraphInput.threadId) {
      toast({
        title: "Error",
        description: "Thread ID not found",
      });
      return undefined;
    }
    if (!useGraphInput.assistantId) {
      toast({
        title: "Error",
        description: "Assistant ID not found",
      });
      return undefined;
    }

    const client = createClient();

    // TODO: update to properly pass the highlight data back
    // one field for highlighted text, and one for code
    const input = {
      artifact,
      ...params,
      ...(selectedBlocks && {
        highlightedText: selectedBlocks,
      }),
    };

    setIsStreaming(true);
    // The root level run ID of this stream
    let runId = "";
    let followupMessageId = "";
    try {
      const stream = client.runs.stream(
        useGraphInput.threadId,
        useGraphInput.assistantId,
        {
          input,
          streamMode: "events",
        }
      );

      // Variables to keep track of content specific to this stream
      const prevCurrentContent = artifact
        ? artifact.contents.find((a) => a.index === artifact.currentIndex)
        : undefined;

      // The new index of the artifact that is generating
      let newArtifactIndex = artifact
        ? artifact.contents.length + 1
        : undefined;

      // The metadata generated when re-writing an artifact
      let rewriteArtifactMeta: RewriteArtifactMetaToolResponse | undefined =
        undefined;

      // For generating an artifact
      let generateArtifactToolCallStr = "";

      // For updating code artifacts
      // All the text up until the startCharIndex
      let updatedArtifactStartContent: string | undefined = undefined;
      // All the text after the endCharIndex
      let updatedArtifactRestContent: string | undefined = undefined;
      // Whether or not the first update has been made when updating highlighted code.
      let isFirstUpdate = true;

      // The new text of an artifact that is being rewritten
      let newArtifactContent = "";

      // The updated full markdown text when using the highlight update tool
      let highlightedText: TextHighlight | undefined = undefined;

      for await (const chunk of stream) {
        try {
          if (!runId && chunk.data?.metadata?.run_id) {
            runId = chunk.data.metadata.run_id;
          }
          if (chunk.data.event === "on_chain_start") {
            if (
              chunk.data.metadata.langgraph_node === "updateHighlightedText"
            ) {
              highlightedText = chunk.data.data?.input?.highlightedText;
            }
          }

          if (chunk.data.event === "on_chat_model_stream") {
            // These are generating new messages to insert to the chat window.
            if (
              ["generateFollowup", "respondToQuery"].includes(
                chunk.data.metadata.langgraph_node
              )
            ) {
              const message = chunk.data.data.chunk[1];
              if (!followupMessageId) {
                followupMessageId = message.id;
              }
              setMessages((prevMessages) =>
                replaceOrInsertMessageChunk(prevMessages, message)
              );
            }

            if (chunk.data.metadata.langgraph_node === "generateArtifact") {
              generateArtifactToolCallStr +=
                chunk.data.data.chunk?.[1]?.tool_call_chunks?.[0]?.args;
              let newArtifactText: ArtifactToolResponse | undefined = undefined;

              // Attempt to parse the tool call chunk.
              try {
                newArtifactText = parsePartialJson(generateArtifactToolCallStr);
                if (!newArtifactText) {
                  throw new Error("Failed to parse new artifact text");
                }
                newArtifactText = {
                  ...newArtifactText,
                  title: newArtifactText.title ?? "",
                  type: newArtifactText.type ?? "",
                };
              } catch (_) {
                continue;
              }

              if (
                newArtifactText.artifact &&
                (newArtifactText.type === "text" ||
                  (newArtifactText.type === "code" && newArtifactText.language))
              ) {
                setArtifact(() => {
                  const content =
                    createNewGeneratedArtifactFromTool(newArtifactText);
                  if (!content) {
                    return undefined;
                  }
                  return {
                    currentIndex: 1,
                    contents: [content],
                  };
                });
              }
            }

            if (
              chunk.data.metadata.langgraph_node === "updateHighlightedText"
            ) {
              const message = chunk.data.data?.chunk[1];
              if (!message) {
                continue;
              }
              if (!artifact) {
                console.error(
                  "No artifacts found when updating highlighted markdown..."
                );
                continue;
              }
              if (!highlightedText) {
                toast({
                  title: "Error",
                  description: "No highlighted text found",
                });
                continue;
              }
              if (!prevCurrentContent) {
                toast({
                  title: "Error",
                  description: "Original artifact not found",
                });
                return;
              }
              if (!isArtifactMarkdownContent(prevCurrentContent)) {
                toast({
                  title: "Error",
                  description: "Received non markdown block update",
                });
                return;
              }

              const partialUpdatedContent = message.content;
              if (!partialUpdatedContent) {
                continue;
              }
              const startIndexOfHighlightedText =
                highlightedText.fullMarkdown.indexOf(
                  highlightedText.markdownBlock
                );

              if (
                updatedArtifactStartContent === undefined &&
                updatedArtifactRestContent === undefined
              ) {
                // Initialize the start and rest content on first chunk
                updatedArtifactStartContent =
                  highlightedText.fullMarkdown.slice(
                    0,
                    startIndexOfHighlightedText
                  );
                updatedArtifactRestContent = highlightedText.fullMarkdown.slice(
                  startIndexOfHighlightedText +
                    highlightedText.markdownBlock.length
                );
              }

              if (
                updatedArtifactStartContent !== undefined &&
                updatedArtifactRestContent !== undefined
              ) {
                updatedArtifactStartContent += partialUpdatedContent;
              }

              if (newArtifactIndex === undefined) {
                newArtifactIndex = artifact.contents.length + 1;
              }
              setArtifact((prev) => {
                return updateHighlightedMarkdown(
                  prev ?? artifact,
                  `${updatedArtifactStartContent}${updatedArtifactRestContent}`,
                  newArtifactIndex ?? artifact.contents.length + 1,
                  prevCurrentContent,
                  isFirstUpdate
                );
              });

              if (isFirstUpdate) {
                isFirstUpdate = false;
              }
            }

            if (chunk.data.metadata.langgraph_node === "updateArtifact") {
              if (!artifact) {
                toast({
                  title: "Error",
                  description: "Original artifact not found",
                });
                return;
              }
              if (!params.highlighted) {
                toast({
                  title: "Error",
                  description: "No highlighted text found",
                });
                return;
              }

              if (newArtifactIndex === undefined) {
                newArtifactIndex = artifact.contents.length + 1;
              }

              const partialUpdatedContent = chunk.data.data.chunk?.[1]?.content;
              if (!partialUpdatedContent) return;
              const { startCharIndex, endCharIndex } = params.highlighted;

              if (!prevCurrentContent) {
                toast({
                  title: "Error",
                  description: "Original artifact not found",
                });
                return;
              }
              if (prevCurrentContent.type !== "code") {
                toast({
                  title: "Error",
                  description: "Received non code block update",
                });
                return;
              }

              if (
                updatedArtifactStartContent === undefined &&
                updatedArtifactRestContent === undefined
              ) {
                updatedArtifactStartContent = prevCurrentContent.code.slice(
                  0,
                  startCharIndex
                );
                updatedArtifactRestContent =
                  prevCurrentContent.code.slice(endCharIndex);
              } else {
                // One of the above have been populated, now we can update the start to contain the new text.
                updatedArtifactStartContent += partialUpdatedContent;
              }

              setArtifact((prev) => {
                const content = removeCodeBlockFormatting(
                  `${updatedArtifactStartContent}${updatedArtifactRestContent}`
                );
                return updateHighlightedCode(
                  prev ?? artifact,
                  content,
                  newArtifactIndex ?? artifact.contents.length + 1,
                  prevCurrentContent,
                  isFirstUpdate
                );
              });

              if (isFirstUpdate) {
                isFirstUpdate = false;
              }
            }

            if (
              chunk.data.metadata.langgraph_node === "rewriteArtifact" &&
              chunk.data.name === "rewrite_artifact_model_call" &&
              rewriteArtifactMeta
            ) {
              if (!artifact) {
                toast({
                  title: "Error",
                  description: "Original artifact not found",
                });
                return;
              }

              newArtifactContent += chunk.data.data.chunk?.[1]?.content || "";

              // Ensure we have the language to update the artifact with
              let artifactLanguage = params.portLanguage || undefined;
              if (
                !artifactLanguage &&
                rewriteArtifactMeta.type === "code" &&
                rewriteArtifactMeta.programmingLanguage
              ) {
                // If the type is `code` we should have a programming language populated
                // in the rewriteArtifactMeta and can use that.
                artifactLanguage =
                  rewriteArtifactMeta.programmingLanguage as ProgrammingLanguageOptions;
              } else if (!artifactLanguage) {
                artifactLanguage =
                  (prevCurrentContent?.title as ProgrammingLanguageOptions) ??
                  "other";
              }

              if (newArtifactIndex === undefined) {
                newArtifactIndex = artifact.contents.length + 1;
              }

              setArtifact((prev) => {
                let content = newArtifactContent;
                if (!rewriteArtifactMeta) {
                  console.error(
                    "No rewrite artifact meta found when updating artifact"
                  );
                  return prev;
                }
                if (rewriteArtifactMeta.type === "code") {
                  content = removeCodeBlockFormatting(content);
                }

                return updateRewrittenArtifact({
                  prevArtifact: prev ?? artifact,
                  newArtifactContent: content,
                  rewriteArtifactMeta: rewriteArtifactMeta,
                  prevCurrentContent,
                  newArtifactIndex:
                    newArtifactIndex || artifact.contents.length + 1,
                  isFirstUpdate,
                  artifactLanguage,
                });
              });

              if (isFirstUpdate) {
                isFirstUpdate = false;
              }
            }

            if (
              [
                "rewriteArtifactTheme",
                "rewriteCodeArtifactTheme",
                "customAction",
              ].includes(chunk.data.metadata.langgraph_node)
            ) {
              if (!artifact) {
                toast({
                  title: "Error",
                  description: "Original artifact not found",
                });
                return;
              }
              if (!prevCurrentContent) {
                toast({
                  title: "Error",
                  description: "Original artifact not found",
                });
                return;
              }

              newArtifactContent += chunk.data.data.chunk?.[1]?.content || "";

              // Ensure we have the language to update the artifact with
              const artifactLanguage =
                params.portLanguage ||
                (isArtifactCodeContent(prevCurrentContent)
                  ? prevCurrentContent.language
                  : "other");

              if (newArtifactIndex === undefined) {
                newArtifactIndex = artifact.contents.length + 1;
              }

              const langGraphNode = chunk.data.metadata.langgraph_node;
              let artifactType: ArtifactType;
              if (langGraphNode === "rewriteCodeArtifactTheme") {
                artifactType = "code";
              } else if (langGraphNode === "rewriteArtifactTheme") {
                artifactType = "text";
              } else {
                artifactType = prevCurrentContent.type;
              }

              setArtifact((prev) => {
                let content = newArtifactContent;
                if (artifactType === "code") {
                  content = removeCodeBlockFormatting(content);
                }

                return updateRewrittenArtifact({
                  prevArtifact: prev ?? artifact,
                  newArtifactContent: content,
                  rewriteArtifactMeta: {
                    type: artifactType,
                    title: prevCurrentContent.title,
                    programmingLanguage: artifactLanguage,
                  },
                  prevCurrentContent,
                  newArtifactIndex:
                    newArtifactIndex || artifact.contents.length + 1,
                  isFirstUpdate,
                  artifactLanguage,
                });
              });

              if (isFirstUpdate) {
                isFirstUpdate = false;
              }
            }
          }

          if (chunk.data.event === "on_chat_model_end") {
            if (
              chunk.data.metadata.langgraph_node === "rewriteArtifact" &&
              chunk.data.name === "optionally_update_artifact_meta"
            ) {
              rewriteArtifactMeta = chunk.data.data.output.tool_calls[0].args;
            }
          }
        } catch (e) {
          console.error(
            "Failed to parse stream chunk",
            chunk,
            "\n\nError:\n",
            e
          );
        }
      }
    } catch (e) {
      console.error("Failed to stream message", e);
    } finally {
      setIsStreaming(false);
    }

    // TODO:
    // Implement an updateState call after streaming is done to update the state of the artifact
    // with the full markdown content of the artifact if it's a text artifact. This is required so
    // users can load the artifact in the future with proper markdown styling.

    if (runId) {
      // Chain `.then` to not block the stream
      shareRun(runId).then(async (sharedRunURL) => {
        setMessages((prevMessages) => {
          const newMsgs = prevMessages.map((msg) => {
            if (
              msg.id === followupMessageId &&
              !(msg as AIMessage).tool_calls?.find(
                (tc) => tc.name === "langsmith_tool_ui"
              )
            ) {
              const toolCall = {
                name: "langsmith_tool_ui",
                args: { sharedRunURL },
                id: sharedRunURL
                  ?.split("https://smith.langchain.com/public/")[1]
                  .split("/")[0],
              };
              const castMsg = msg as AIMessage;
              const newMessageWithToolCall = new AIMessage({
                ...castMsg,
                content: castMsg.content,
                id: castMsg.id,
                tool_calls: castMsg.tool_calls
                  ? [...castMsg.tool_calls, toolCall]
                  : [toolCall],
              });
              return newMessageWithToolCall;
            }
            return msg;
          });
          return newMsgs;
        });

        // if (useGraphInput.threadId && lastMessage) {
        //   // Update the state of the last message to include the run URL
        //   // for proper rendering when loading history.
        //   if (lastMessage.type === "ai") {
        //     const newMessages = [new RemoveMessage({ id: lastMessage.id }), new AIMessage({
        //       ...lastMessage,
        //       content: lastMessage.content,
        //       response_metadata: {
        //         ...lastMessage.response_metadata,
        //         langSmithRunURL: sharedRunURL,
        //       }
        //     })];
        //     await client.threads.updateState(useGraphInput.threadId, {
        //       values: {
        //         messages: newMessages
        //       },
        //     });
        //     const newState = await client.threads.getState(useGraphInput.threadId);
        //   }
        // }
      });
    }
  };

  const setSelectedArtifact = (index: number) => {
    setIsStreaming(true);
    setArtifact((prev) => {
      if (!prev) {
        toast({
          title: "Error",
          description: "No artifactV2 found",
        });
        return prev;
      }
      return {
        ...prev,
        currentIndex: index,
      };
    });
    setIsStreaming(false);
  };

  const setArtifactContent = (index: number, content: string) => {
    setIsStreaming(true);
    setArtifact((prev) => {
      if (!prev) {
        toast({
          title: "Error",
          description: "No artifact found",
        });
        return prev;
      }
      return {
        ...prev,
        currentIndex: index,
        contents: prev.contents.map((a) => {
          if (a.index === index && a.type === "code") {
            return {
              ...a,
              code: reverseCleanContent(content),
            };
          }
          return a;
        }),
      };
    });
    setIsStreaming(false);
  };

  const switchSelectedThread = (
    thread: Thread,
    setThreadId: (id: string) => void
  ) => {
    setThreadId(thread.thread_id);
    setCookie(THREAD_ID_COOKIE_NAME, thread.thread_id);
    console.log("thrad.values", thread.values);
    const castValues: {
      artifact: ArtifactV3 | undefined;
      messages: Record<string, any>[] | undefined;
    } = {
      artifact: undefined,
      messages: (thread.values as Record<string, any>)?.messages || undefined,
    };
    const castThreadValues = thread.values as Record<string, any>;
    if (castThreadValues?.artifact) {
      if (isDeprecatedArtifactType(castThreadValues.artifact)) {
        castValues.artifact = convertToArtifactV3(castThreadValues.artifact);
      } else {
        castValues.artifact = castThreadValues.artifact;
      }
    } else {
      castValues.artifact = undefined;
    }

    if (!castValues?.messages?.length) {
      setMessages([]);
      setArtifact(castValues?.artifact);
      return;
    }
    setArtifact(castValues?.artifact);
    setMessages(
      castValues.messages.map((msg: Record<string, any>) => {
        if (msg.response_metadata?.langSmithRunURL) {
          msg.tool_calls = msg.tool_calls ?? [];
          msg.tool_calls.push({
            name: "langsmith_tool_ui",
            args: { sharedRunURL: msg.response_metadata.langSmithRunURL },
            id: msg.response_metadata.langSmithRunURL
              ?.split("https://smith.langchain.com/public/")[1]
              .split("/")[0],
          });
        }

        return msg as BaseMessage;
      })
    );
  };

  return {
    isStreaming,
    selectedBlocks,
    messages,
    artifact,
    setArtifact,
    setSelectedBlocks,
    setSelectedArtifact,
    setMessages,
    streamMessage: streamMessageV2,
    setArtifactContent,
    clearState,
    switchSelectedThread,
  };
}