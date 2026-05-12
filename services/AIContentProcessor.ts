import {
  AIProcessingRequest,
  AIProcessingResponse,
  GeneratedExercise,
  ExerciseType,
  DifficultyLevel,
  QuestionFeedback,
} from '@/types/ai-learning';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

// ─────────────────────────────────────────────
//  Config
// ─────────────────────────────────────────────
interface AIConfig {
  provider: 'bedrock' | 'local';
  apiKey?: string;
  model?: string;
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

/** Split text into overlapping chunks of ~chunkSize chars */
function splitIntoChunks(text: string, chunkSize = 1500): string[] {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + chunkSize));
    start += Math.floor(chunkSize * 0.8); // 20% overlap
  }
  return chunks;
}

/** Pick a pseudo-random chunk index that spreads evenly */
function pickChunk(chunks: string[], exerciseIndex: number): string {
  const idx = exerciseIndex % chunks.length;
  return chunks[idx];
}

/** Extract a JSON object from arbitrary text */
function extractJson(text: string): any | null {
  // 1. Code-fence block
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { }
  }
  // 2. First {...} block
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) {
    try { return JSON.parse(brace[0]); } catch { }
  }
  // 3. Clean and retry
  const cleaned = text
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3') // unquoted keys
    .replace(/,\s*([\]}])/g, '$1');               // trailing commas
  const brace2 = cleaned.match(/\{[\s\S]*\}/);
  if (brace2) {
    try { return JSON.parse(brace2[0]); } catch { }
  }
  return null;
}

/** Very thin local fallback — generates a plausible MC question from a chunk */
function buildFallbackExercise(
  chunk: string,
  index: number,
  contentId: string,
  difficulty: DifficultyLevel,
): GeneratedExercise {
  const sentences = chunk
    .split(/[.!?]\s+/)
    .filter(s => s.trim().length > 20)
    .slice(0, 4);

  const question = sentences[0]
    ? `מה נאמר בקטע הבא? "${sentences[0].slice(0, 80)}..."`
    : `שאלה על הנושא הנלמד (${index + 1})`;

  const correctAnswer = sentences[1]?.slice(0, 60) || 'ראה את החומר המלא';
  const distractors = [
    sentences[2]?.slice(0, 60) || 'תשובה שגויה א',
    sentences[3]?.slice(0, 60) || 'תשובה שגויה ב',
    'אף אחת מהתשובות הנ"ל',
  ];

  const options = [correctAnswer, ...distractors].sort(() => Math.random() - 0.5);
  const correctIndex = options.indexOf(correctAnswer);

  return {
    id: `local-${contentId}-${index}-${Date.now()}`,
    contentId,
    type: 'multiple-choice',
    question,
    options,
    correctAnswer: correctIndex,
    explanation: sentences[1] || 'ראה את החומר למידע נוסף.',
    difficulty,
    topic: 'כללי',
    keywords: [],
  };
}

// ─────────────────────────────────────────────
//  Main class
// ─────────────────────────────────────────────
class AIContentProcessor {
  private config: AIConfig;

  constructor(config: AIConfig) {
    this.config = config;
  }

  // ── URL helpers ──────────────────────────────
  private getProxyUrl(path: string): string {
    // אנו מנתקים לחלוטין את השרת הישן (Render) ומכל משתנה סביבה ישן שנתקע.
    // מעכשיו האפליקציה תמיד תפנה לנתיב היחסי (לדוגמה /api/ai-chat) 
    // שעליו מאזין השרת המובנה של Vercel באותו הדומיין.
    return path;
  }

  private getApiKey(): string | null {
    return (
      this.config.apiKey ||
      (typeof process !== 'undefined'
        ? (process.env?.EXPO_PUBLIC_AI_API_KEY || process.env?.EXPO_PUBLIC_GEMINI_API_KEY)
        : null) ||
      (() => {
        try {
          return Constants.expoConfig?.extra?.EXPO_PUBLIC_AI_API_KEY || Constants.expoConfig?.extra?.EXPO_PUBLIC_GEMINI_API_KEY;
        } catch {
          return null;
        }
      })() ||
      null
    );
  }

  // ── Core: call proxy with ONE question request ──
  private async callProxy(prompt: string): Promise<string | null> {
    const url = this.getProxyUrl('/api/ai-chat');
    if (!url) return null;

    const apiKey = this.getApiKey();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const defaultBedrockModel = 'anthropic.claude-3-sonnet-20240229-v1:0';
    const model = this.config.model || (this.config.provider === 'bedrock' ? defaultBedrockModel : undefined);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          question: prompt,
          systemPrompt:
            'אתה מורה שיוצר שאלות לימוד בעברית. החזר JSON בלבד, ללא הסברים נוספים.',
          history: [],
          provider: this.config.provider,
          model: model,
        }),
      });
      if (!res.ok) {
        console.warn(`[AI] Proxy returned ${res.status}`);
        return null;
      }
      const data = await res.json();
      return data.answer || null;
    } catch (e) {
      console.warn('[AI] Proxy call failed:', e);
      return null;
    }
  }

  // ── Generate ONE exercise from a chunk ──
  private async generateOneExercise(
    chunk: string,
    subject: string,
    difficulty: DifficultyLevel,
    exerciseType: ExerciseType,
    contentId: string,
    index: number,
  ): Promise<GeneratedExercise | null> {

    const isMultiChoice = exerciseType === 'multiple-choice';
    const isTrueFalse = exerciseType === 'true-false';

    let prompt: string;

    if (isTrueFalse) {
      prompt = `קרא את הקטע הבא ויצור שאלת נכון/לא-נכון אחת בעברית.

קטע:
${chunk}

החזר JSON בלבד:
{"question":"שאלה כאן","correctAnswer":0,"explanation":"הסבר כאן"}

כאשר correctAnswer הוא 0 לנכון ו-1 ללא-נכון.
אל תשתמש במרכאות כפולות בתוך הטקסט — השתמש בגרשיים בודדים.`;
    } else if (isMultiChoice) {
      prompt = `קרא את הקטע הבא ויצור שאלת רב-ברירה אחת בעברית.

קטע:
${chunk}

החזר JSON בלבד:
{"question":"שאלה","options":["תשובה נכונה","תשובה שגויה 1","תשובה שגויה 2","תשובה שגויה 3"],"correctAnswer":0,"explanation":"הסבר קצר"}

הוראות מדויקות:
- options[0] חייבת להיות התשובה הנכונה.
- השתמש במרכאות יחידיות ('), אל תשתמש במרכאות כפולות.
- כל ערך בטקסט צריך להיות קצר (עד 80 תווים).
- ההסבר יכול להיות ריק אך יש לכלול מפתח explanation.
- אל תוסיף טקסט לפני או אחרי ה-JSON.`;
    } else {
      // fill-blank / short-answer
      prompt = `קרא את הקטע הבא ויצור שאלת השלמה אחת בעברית.

קטע:
${chunk}

החזר JSON בלבד:
{"question":"השלם: ___ הוא...","correctAnswer":"המילה החסרה","explanation":"הסבר"}

אל תשתמש במרכאות כפולות בתוך הטקסטים.`;
    }

    // Try proxy
    let raw = await this.callProxy(prompt);
    if (!raw) return null;

    const parsed = extractJson(raw);
    // Validate structure – must contain question, options array with at least 2 items and correctAnswer index
    if (
      !parsed ||
      typeof parsed.question !== 'string' ||
      !Array.isArray(parsed.options) ||
      parsed.options.length < 2 ||
      typeof parsed.correctAnswer !== 'number' ||
      parsed.correctAnswer < 0 ||
      parsed.correctAnswer >= parsed.options.length
    ) {
      // Fallback to local generation if AI response is malformed
      return null;
    }

    // Shuffle options so correct answer isn't always index 0
    let options: string[] | undefined;
    let correctAnswer: number | string = parsed.correctAnswer ?? 0;

    if (isMultiChoice && Array.isArray(parsed.options)) {
      options = [...parsed.options];
      const correctText = options[0]; // per prompt, index 0 is correct
      // shuffle
      for (let i = options.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [options[i], options[j]] = [options[j], options[i]];
      }
      correctAnswer = options.indexOf(correctText);
      if (correctAnswer < 0) correctAnswer = 0;
    } else if (isTrueFalse) {
      options = ['נכון', 'לא נכון'];
      correctAnswer = typeof parsed.correctAnswer === 'number'
        ? parsed.correctAnswer
        : (String(parsed.correctAnswer) === '0' ? 0 : 1);
    }

    return {
      id: `ai-${contentId}-${index}-${Date.now()}`,
      contentId,
      type: exerciseType,
      question: String(parsed.question || '').replace(/"/g, "'"),
      options,
      correctAnswer,
      explanation: String(parsed.explanation || '').replace(/"/g, "'"),
      difficulty,
      topic: subject,
      keywords: [],
    };
  }

  // ── Public: process content → exercises ──
  async processContent(req: AIProcessingRequest): Promise<AIProcessingResponse> {
    const start = Date.now();
    const {
      contentId,
      content,
      subject,
      numberOfExercises,
      targetDifficulty,
      preferredExerciseTypes,
    } = req;

    const chunks = splitIntoChunks(content, 1500);
    const difficulties: DifficultyLevel[] =
      targetDifficulty?.length ? targetDifficulty : ['medium'];
    const types: ExerciseType[] =
      preferredExerciseTypes?.length
        ? preferredExerciseTypes
        : ['multiple-choice', 'true-false'];

    // Build individual exercise tasks
    const tasks = Array.from({ length: numberOfExercises }, (_, i) => {
      const chunk = pickChunk(chunks, i);
      const difficulty = difficulties[i % difficulties.length];
      const type = types[i % types.length];
      return { chunk, difficulty, type, index: i };
    });

    // Run all tasks concurrently (but cap at 5 in-flight at once)
    const exercises: GeneratedExercise[] = [];
    const CONCURRENCY = 5;

    for (let start = 0; start < tasks.length; start += CONCURRENCY) {
      const batch = tasks.slice(start, start + CONCURRENCY);
      const results = await Promise.all(
        batch.map(t =>
          this.generateOneExercise(
            t.chunk,
            subject,
            t.difficulty,
            t.type,
            contentId,
            t.index,
          ).catch(() => null)
        )
      );
      results.forEach((ex, bi) => {
        if (ex) {
          exercises.push(ex);
        } else {
          // Fallback: generate locally
          const t = batch[bi];
          exercises.push(
            buildFallbackExercise(t.chunk, t.index, contentId, t.difficulty)
          );
        }
      });
    }

    return {
      contentId,
      exercises,
      summary: 'קורס נוצר מהחומר שהעלית',
      keyTopics: [],
      estimatedLearningTime: Math.ceil(exercises.length * 1.5),
      processingTime: Date.now() - start,
    };
  }

  // ── Public: analyze content (lightweight) ──
  async analyzeContent(
    content: string,
    subject: string
  ): Promise<{ summary: string; topics: string[] }> {
    // Extract topics locally — no AI call needed just for metadata
    const words = content.split(/\s+/).filter(w => w.length > 3);
    const freq: Record<string, number> = {};
    words.forEach(w => {
      const key = w.replace(/[^\u05D0-\u05FAa-zA-Z]/g, '');
      if (key.length > 2) freq[key] = (freq[key] || 0) + 1;
    });
    const topics = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w]) => w);

    return {
      summary: `קורס בנושא ${subject} - ${Math.ceil(content.length / 500)} עמודים`,
      topics,
    };
  }

  // ── Public: generate dynamic course plan (simplified) ──
  async generateDynamicCoursePlan(
    _subject: string,
    _summary: string,
    _contentLength: number
  ): Promise<null> {
    // Return null → CourseGenerator will use COURSE_PHASES_CONFIG defaults
    return null;
  }

  // ── Public: generate title + subject ──
  async generateTitleAndSubject(
    content: string
  ): Promise<{ title: string; subject: string }> {
    return this.extractTitleAndSubjectLocally(content);
  }

  private extractTitleAndSubjectLocally(content: string): {
    title: string;
    subject: string;
  } {
    const firstLine = content
      .split('\n')
      .map(l => l.trim())
      .find(l => l.length > 5 && l.length < 80);
    const title = firstLine || 'קורס לימוד';

    const subjectKeywords: Record<string, string[]> = {
      מתמטיקה: ['חשבון', 'משוואה', 'גיאומטריה', 'פונקציה', 'אינטגרל'],
      ביולוגיה: ['תא', 'גנטיקה', 'אבולוציה', 'חיידק', 'DNA'],
      היסטוריה: ['מלחמה', 'מלך', 'ממלכה', 'מהפכה', 'שנת'],
      תכנות: ['קוד', 'פונקציה', 'מחלקה', 'אלגוריתם', 'משתנה'],
      רפואה: ['חולה', 'טיפול', 'תרופה', 'אבחון', 'ניתוח', 'הצלה', 'פציעה'],
      פיזיקה: ['כוח', 'מהירות', 'אנרגיה', 'חשמל', 'גל'],
    };

    let detected = 'כללי';
    for (const [subj, keys] of Object.entries(subjectKeywords)) {
      if (keys.some(k => content.includes(k))) {
        detected = subj;
        break;
      }
    }

    return { title, subject: detected };
  }

  // ── Public: check answer with AI ──
  async checkAnswerWithAI(
    question: string,
    userAnswer: string,
    correctAnswer: string
  ): Promise<{ isCorrect: boolean; feedback: string }> {
    const prompt = `שאלה: ${question}
תשובת המשתמש: ${userAnswer}
התשובה הנכונה: ${correctAnswer}

האם תשובת המשתמש נכונה מבחינה מהותית? ענה בJSON:
{"isCorrect":true,"feedback":"הסבר קצר"}`;

    const raw = await this.callProxy(prompt);
    if (raw) {
      const parsed = extractJson(raw);
      if (
        parsed &&
        typeof parsed.isCorrect === 'boolean' &&
        typeof parsed.feedback === 'string'
      ) {
        return { isCorrect: parsed.isCorrect, feedback: parsed.feedback };
      }
    }
    // Simple heuristic fallback – case‑insensitive contains check
    const norm = (s: string) => s.trim().toLowerCase().replace(/[\'\"]/g, '');
    const isCorrect =
      norm(userAnswer).includes(norm(correctAnswer)) ||
      norm(correctAnswer).includes(norm(userAnswer));
    return { isCorrect, feedback: isCorrect ? 'תשובה נכונה!' : `התשובה הנכונה: ${correctAnswer}` };


    // Duplicate fallback removed – original norm implementation retained above
  }

  // ── Feedback (unchanged contract) ──
  async submitFeedback(_feedback: QuestionFeedback): Promise<void> {
    // No-op: feedback is stored locally in the store
  }
}

// ─────────────────────────────────────────────
//  Singleton
// ─────────────────────────────────────────────
let processorInstance: AIContentProcessor | null = null;

export function initializeAIProcessor(config: AIConfig): AIContentProcessor {
  console.log(
    `[AI] initializeAIProcessor: provider=${config.provider} apiKey=${config.apiKey ? 'set' : 'missing'}`
  );
  processorInstance = new AIContentProcessor(config);
  return processorInstance;
}

export function getAIProcessor(): AIContentProcessor {
  if (!processorInstance) {
    // Auto-initialize with defaults
    const provider = (typeof process !== 'undefined'
      ? process.env?.EXPO_PUBLIC_AI_PROVIDER
      : null) as AIConfig['provider'] ?? 'bedrock';
    processorInstance = new AIContentProcessor({ provider });
  }
  return processorInstance;
}

export { AIContentProcessor };
