// Judgment backends. Review code asks the same questions either way; this
// module owns which SDK answers them: the TypeSafe SDK, or the Vercel AI SDK
// through AI Gateway. Both run the same Jev engine, so only backend selection,
// the request plumbing, and the answer shape live here.
import {
  choice as typesafeChoice,
  noul as typesafeNoul,
  score as typesafeScore,
  TypeSafeClient,
  type Question as TypesafeQuestion,
} from "@typesafe-ai/sdk";
import { experimental_evaluate as evaluate, type ProviderMetadata } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { rateLimitedFetch } from "./gateway-fetch.ts";
import type { JudgmentBackend } from "../domain/types.ts";

// The only evaluation model AI Gateway serves today.
const GATEWAY_MODEL = "typesafe-ai/jev";

const gateway = createGateway({ fetch: rateLimitedFetch() });

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type Input = string | { [key: string]: Json } | Json[];

type BooleanQuestion = {
  type: "boolean";
  instructions: Input;
  criteria?: { true?: Input; false?: Input };
};

type ChoiceQuestion = {
  type: "choice";
  instructions: Input;
  criteria: Readonly<Record<string, Input>>;
};

type ScoreQuestion = {
  type: "score";
  instructions: Input;
  criteria: readonly [Input, Input, ...Input[]];
};

export type Question = BooleanQuestion | ChoiceQuestion | ScoreQuestion;

export type Questions = Record<string, Question>;

type AnswerByType = {
  boolean: { probability: number; confidence: number };
  choice: { choice: string; confidence: number };
  score: { score: number; confidence: number };
};

export type Answers<Q extends Questions> = { [K in keyof Q]: AnswerByType[Q[K]["type"]] };

export function noul(instructions: Input, criteria?: BooleanQuestion["criteria"]): BooleanQuestion {
  return { type: "boolean", instructions, criteria };
}

export function choice(instructions: Input, criteria: ChoiceQuestion["criteria"]): ChoiceQuestion {
  return { type: "choice", instructions, criteria };
}

export function score(instructions: Input, criteria: ScoreQuestion["criteria"]): ScoreQuestion {
  return { type: "score", instructions, criteria };
}

// The TypeSafe SDK reports the yes/no question type as "noul".
export function typesafeQuestion(question: Question): TypesafeQuestion {
  if (question.type === "boolean") return typesafeNoul(question.instructions, question.criteria);

  if (question.type === "choice") return typesafeChoice(question.instructions, question.criteria);

  return typesafeScore(question.instructions, question.criteria);
}

export function judgmentBackend(): JudgmentBackend {
  const backend =
    process.env.JUDGE_BACKEND || (process.env.TYPESAFE_API_KEY ? "typesafe" : "ai-gateway");

  if (backend !== "typesafe" && backend !== "ai-gateway") {
    throw new Error('JUDGE_BACKEND must be "typesafe" or "ai-gateway", got "' + backend + '"');
  }

  const key = backend === "typesafe" ? "TYPESAFE_API_KEY" : "AI_GATEWAY_API_KEY";

  if (!process.env[key]) {
    throw new Error("Set " + key + " to run judgments with the " + backend + " backend");
  }

  return backend;
}

export function ask<const Q extends Questions>(request: {
  state: Input;
  questions: Q;
}): Promise<{ answers: Answers<Q> }> {
  if (judgmentBackend() === "ai-gateway") return askGateway(request);

  return askTypesafe(request);
}

let client: TypeSafeClient | undefined;

async function askTypesafe<const Q extends Questions>({
  state,
  questions,
}: {
  state: Input;
  questions: Q;
}): Promise<{ answers: Answers<Q> }> {
  client ??= new TypeSafeClient();

  const result = await client.systemOne({
    state,
    questions: Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [id, typesafeQuestion(question)]),
    ),
  });

  return { answers: collect(questions, (id) => typesafeAnswer(result.answers[id])) };
}

async function askGateway<const Q extends Questions>({
  state,
  questions,
}: {
  state: Input;
  questions: Q;
}): Promise<{ answers: Answers<Q> }> {
  const result = await evaluate({
    model: gateway.evaluationModel(GATEWAY_MODEL),
    state,
    questions,
  });

  return { answers: collect(questions, (id) => gatewayAnswer(result, id)) };
}

// One flat answer for both backends; fields that do not apply to a question stay zero.
type Flat = { probability: number; choice: string; score: number; confidence: number };

const EMPTY: Flat = { probability: 0, choice: "", score: 0, confidence: 0 };

export type TypesafeAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number }
  | { type: "score"; score: number; confidence: number };

type GatewayAnswer =
  | { type: "boolean"; probability: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number> }
  | { type: "score"; score: number; probabilities?: Record<string, number> };

export type GatewayResult = {
  answers: Record<string, GatewayAnswer>;
  providerMetadata?: ProviderMetadata;
};

export function typesafeAnswer(answer: TypesafeAnswer): Flat {
  if (answer.type === "noul")
    return { ...EMPTY, probability: answer.noul, confidence: answer.noul };

  if (answer.type === "choice")
    return { ...EMPTY, choice: answer.choice, confidence: answer.confidence };

  return { ...EMPTY, score: answer.score, confidence: answer.confidence };
}

export function gatewayAnswer(result: GatewayResult, id: string): Flat {
  const reported = confidenceOf(result, id);
  const answer = result.answers[id];

  if (answer.type === "boolean") {
    return {
      ...EMPTY,
      probability: answer.probability,
      confidence: reported ?? answer.probability,
    };
  }

  if (answer.type === "choice") {
    return {
      ...EMPTY,
      choice: answer.choice,
      confidence: reported ?? topProbability(answer.probabilities),
    };
  }

  return {
    ...EMPTY,
    score: answer.score,
    confidence: reported ?? topProbability(answer.probabilities),
  };
}

// Jev reports confidence per question next to the answers; without it a
// finding scores zero and the location threshold drops every one of them.
function confidenceOf(result: GatewayResult, id: string): number | undefined {
  const confidence = result.providerMetadata?.typesafe?.confidence;

  if (typeof confidence !== "object" || confidence === null || Array.isArray(confidence))
    return undefined;
  const value = Object.entries(confidence).find(([key]) => key === id)?.[1];

  return typeof value === "number" ? value : undefined;
}

function topProbability(probabilities: Record<string, number> | undefined): number {
  const values = Object.values(probabilities ?? {});

  return values.length > 0 ? Math.max(...values) : 0;
}

function collect<const Q extends Questions>(questions: Q, read: (id: string) => Flat): Answers<Q> {
  const answers = Object.entries(questions).map(([id, question]) => [
    id,
    selectAnswer(question.type, read(id)),
  ]);

  // SAFETY: Every question key is preserved and selectAnswer selects its matching answer type.
  return Object.fromEntries(answers) as Answers<Q>;
}

function selectAnswer(type: Question["type"], answer: Flat): AnswerByType[Question["type"]] {
  if (type === "boolean") return { probability: answer.probability, confidence: answer.confidence };

  if (type === "choice") return { choice: answer.choice, confidence: answer.confidence };

  return { score: answer.score, confidence: answer.confidence };
}
