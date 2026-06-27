// Questionable Decisions trivia content + board building + answer validation.
// Server-owned so correctness never depends on the client. Content here is a
// compact structured seed (3 themes x 4 categories x 4 tiers = a full 4x4 board
// per theme); the prose question packs under the cabinet folder can be ingested
// into this shape later without changing the engine.
//
// Question formats: "true-false" and "multiple-choice" carry `choices` (the
// controller renders them as buttons); "typed-answer" carries `acceptedAnswers`
// (the controller renders a text field). `answer` is the canonical correct value
// as a display string. Nothing here is sent to clients until answer reveal.

export const QD_POINT_TIERS = [100, 200, 300, 400];

function tf(points, prompt, answer) {
  return { points, format: "true-false", prompt, choices: ["True", "False"], answer: answer ? "True" : "False" };
}
function mc(points, prompt, choices, answer) {
  return { points, format: "multiple-choice", prompt, choices, answer };
}
function typed(points, prompt, answer, acceptedAnswers = []) {
  return { points, format: "typed-answer", prompt, answer, acceptedAnswers: [answer, ...acceptedAnswers] };
}

// Each category supplies exactly one question per tier in QD_POINT_TIERS order.
export const QD_THEMES = [
  {
    id: "internet-brain",
    title: "Internet Brain",
    categories: [
      { id: "memes", title: "Meme Lore", questions: [
        tf(100, "Doge is a Shiba Inu.", true),
        mc(200, "Which app popularized six-second looping videos?", ["Vine", "Tumblr", "Periscope", "Meerkat"], "Vine"),
        mc(300, "\"Rickrolling\" links to a song by which artist?", ["Rick Astley", "Rick James", "Rick Ross", "Rick Springfield"], "Rick Astley"),
        typed(400, "What single word is the name of the cat meme spelled with intentionally bad grammar, e.g. \"I can ___ cheeseburger\"?", "haz"),
      ] },
      { id: "platforms", title: "Platforms", questions: [
        tf(100, "Twitter's original character limit was 140.", true),
        mc(200, "What was YouTube's first uploaded video about?", ["A zoo", "A cat", "A concert", "A game"], "A zoo"),
        mc(300, "Which site used 'subreddits'?", ["Reddit", "Digg", "Slashdot", "StumbleUpon"], "Reddit"),
        typed(400, "What does the 'http' in a web address stand for? (first word)", "hypertext"),
      ] },
      { id: "oldweb", title: "Old Web", questions: [
        tf(100, "MySpace let you pick a Top 8 friends list.", true),
        mc(200, "Which service was known for away messages?", ["AIM", "ICQ", "MSN", "Skype"], "AIM"),
        mc(300, "'Web 1.0' pages were mostly known for being?", ["Static", "Interactive", "AI-driven", "Live"], "Static"),
        typed(400, "Name the dancing baby's common nickname animation format (3 letters).", "gif"),
      ] },
      { id: "viral", title: "Gone Viral", questions: [
        tf(100, "The 'Ice Bucket Challenge' raised money for ALS research.", true),
        mc(200, "'The Dress' debate was about which two color pairs?", ["Blue/black vs white/gold", "Red/green", "Pink/grey", "Black/white"], "Blue/black vs white/gold"),
        mc(300, "Which animal escaped a zoo and trended for days in 2021 (Texas)?", ["A tiger", "A penguin", "A llama", "A bear"], "A tiger"),
        typed(400, "What bird became a meme for 'the ___ is the word'?", "bird"),
      ] },
    ],
  },
  {
    id: "video-games",
    title: "Video Games",
    categories: [
      { id: "classics", title: "Classics", questions: [
        tf(100, "Pac-Man eats dots and avoids ghosts.", true),
        mc(200, "Who is Nintendo's mustachioed mascot?", ["Mario", "Luigi", "Wario", "Toad"], "Mario"),
        mc(300, "Which company made the Sonic the Hedgehog series?", ["Sega", "Sony", "Atari", "Capcom"], "Sega"),
        typed(400, "What yellow electric creature is Pokemon's mascot?", "pikachu"),
      ] },
      { id: "consoles", title: "Consoles", questions: [
        tf(100, "The PlayStation was made by Sony.", true),
        mc(200, "Which console used motion controls and a 'Wii Remote'?", ["Wii", "GameCube", "Switch", "64"], "Wii"),
        mc(300, "The Xbox is made by which company?", ["Microsoft", "Sony", "Nintendo", "Sega"], "Microsoft"),
        typed(400, "What handheld console line includes the 'Advance' and 'Color' models?", "game boy", ["gameboy"]),
      ] },
      { id: "bosses", title: "Boss Fights", questions: [
        tf(100, "In many games, a 'boss' is a tougher enemy at the end of a level.", true),
        mc(200, "Bowser is the main villain in which series?", ["Mario", "Zelda", "Metroid", "Kirby"], "Mario"),
        mc(300, "Ganon is the recurring villain in which series?", ["Zelda", "Final Fantasy", "Halo", "Doom"], "Zelda"),
        typed(400, "In Dark Souls, defeating a boss rewards you with what currency-like substance? (one word)", "souls"),
      ] },
      { id: "launch", title: "Launch Disasters", questions: [
        tf(100, "A 'day-one patch' is a download released the same day a game launches.", true),
        mc(200, "Which 2020 RPG was infamous for a buggy console launch?", ["Cyberpunk 2077", "Skyrim", "Witcher 3", "Fallout 4"], "Cyberpunk 2077"),
        mc(300, "The 1983 video game crash is often blamed on a game based on which movie?", ["E.T.", "Tron", "Jaws", "Rocky"], "E.T."),
        typed(400, "What three letters describe an early, unfinished test build players sometimes get? (e.g. open ___)", "beta"),
      ] },
    ],
  },
  {
    id: "general-knowledge",
    title: "General Knowledge",
    categories: [
      { id: "geography", title: "Geography", questions: [
        tf(100, "Australia is both a country and a continent.", true),
        mc(200, "Which is the largest ocean?", ["Pacific", "Atlantic", "Indian", "Arctic"], "Pacific"),
        mc(300, "Mount Everest sits on the border of Nepal and which country?", ["China", "India", "Bhutan", "Pakistan"], "China"),
        typed(400, "What is the capital city of Australia?", "canberra"),
      ] },
      { id: "science", title: "Weird Science", questions: [
        tf(100, "Sound travels faster in water than in air.", true),
        mc(200, "Which planet is closest to the Sun?", ["Mercury", "Venus", "Earth", "Mars"], "Mercury"),
        mc(300, "Which gas do plants primarily absorb for photosynthesis?", ["Carbon dioxide", "Oxygen", "Nitrogen", "Helium"], "Carbon dioxide"),
        typed(400, "What is the chemical symbol for gold?", "au"),
      ] },
      { id: "history", title: "History", questions: [
        tf(100, "The Great Wall of China is located in China.", true),
        mc(200, "Who was the first President of the United States?", ["George Washington", "Abraham Lincoln", "Thomas Jefferson", "John Adams"], "George Washington"),
        mc(300, "The Titanic sank in which year?", ["1912", "1905", "1920", "1898"], "1912"),
        typed(400, "Which ancient civilization built the pyramids at Giza?", "egyptians", ["egypt", "egyptian"]),
      ] },
      { id: "food", title: "Food Court", questions: [
        tf(100, "A tomato is botanically a fruit.", true),
        mc(200, "Which country is the origin of sushi?", ["Japan", "China", "Korea", "Thailand"], "Japan"),
        mc(300, "Parmesan cheese originates from which country?", ["Italy", "France", "Greece", "Spain"], "Italy"),
        typed(400, "What spice, derived from a crocus flower, is famously the most expensive by weight?", "saffron"),
      ] },
    ],
  },
];

export function listThemes() {
  return QD_THEMES.map((theme) => ({ id: theme.id, title: theme.title }));
}

export function getTheme(themeId) {
  return QD_THEMES.find((theme) => theme.id === themeId) || null;
}

// Build the authoritative 4x4 board for a theme. Each tile carries an embedded
// question (with the answer) — strip the answer before sending to clients.
export function buildBoard(themeId) {
  const theme = getTheme(themeId);
  if (!theme) return null;
  return {
    themeId: theme.id,
    title: theme.title,
    categories: theme.categories.map((category) => ({
      id: category.id,
      title: category.title,
      tiles: QD_POINT_TIERS.map((points) => {
        const question = category.questions.find((q) => q.points === points) || category.questions[0];
        return {
          points,
          used: false,
          question: {
            categoryId: category.id,
            category: category.title,
            points,
            format: question.format,
            prompt: question.prompt,
            choices: question.choices ? [...question.choices] : null,
            answer: question.answer,
            acceptedAnswers: question.acceptedAnswers ? [...question.acceptedAnswers] : [String(question.answer)],
          },
        };
      }),
    })),
  };
}

// --- answer validation (GDD section 9): strict, predictable, no broad fuzzing ---
export function normalizeAnswer(value) {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,!?;:'"]+$/g, "");
}

export function isAnswerCorrect(question, submitted) {
  if (!question) return false;
  const guess = normalizeAnswer(submitted);
  if (!guess) return false;
  if (question.format === "multiple-choice" || question.format === "true-false") {
    return guess === normalizeAnswer(question.answer);
  }
  const accepted = (question.acceptedAnswers && question.acceptedAnswers.length ? question.acceptedAnswers : [question.answer]);
  return accepted.some((candidate) => normalizeAnswer(candidate) === guess);
}
