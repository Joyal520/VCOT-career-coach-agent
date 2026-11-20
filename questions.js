window.VCOT_INTERVIEW_DATA = (function () {
  const PREPLANNED_QUESTIONS = [
    {
      id: 1,
      numberWord: "one",
      topic: "Introduce Yourself",
      question: "Can you tell me about yourself?",
    },
    {
      id: 2,
      numberWord: "two",
      topic: "Education",
      question: "What did you study, and what skills did you learn?",
    },
    {
      id: 3,
      numberWord: "three",
      topic: "Job Interest",
      question: "Why do you want this job?",
    },
    {
      id: 4,
      numberWord: "four",
      topic: "Strengths",
      question: "What are your strengths?",
    },
    {
      id: 5,
      numberWord: "five",
      topic: "Weaknesses",
      question: "What is one skill you want to improve?",
    },
    {
      id: 6,
      numberWord: "six",
      topic: "Experience",
      question: "Do you have any experience related to this job?",
    },
    {
      id: 7,
      numberWord: "seven",
      topic: "Problem Solving",
      question: "Tell me about a problem you faced. How did you solve it?",
    },
    {
      id: 8,
      numberWord: "eight",
      topic: "Teamwork",
      question: "Can you work with other people as a team? Give me an example.",
    },
    {
      id: 9,
      numberWord: "nine",
      topic: "Future Goals",
      question: "Where do you see yourself in five years?",
    },
    {
      id: 10,
      numberWord: "ten",
      topic: "Final Question",
      question: "Why should we hire you for this job?",
    },
  ];

  const CAREER_ROLES = [
    "ICT Teacher",
    "English Teacher",
    "Software Developer",
    "Administrative Assistant",
    "Customer Service",
    "Nursing",
    "Internship",
    "Scholarship",
    "University Admission",
  ];

  function getOpeningScriptLines(name) {
    const safeName = (name || "Student").trim() || "Student";
    return [
      `Hello, ${safeName}!`,
      "Welcome to your interview practice session.",
      "Today, I will ask you ten common interview questions.",
      "Please listen carefully and answer each question in your own words.",
      "Don't worry about making mistakes. This is a practice session to help you improve.",
      "I will speak slowly and use simple English.",
      "Are you ready?",
      "Let's begin!",
    ];
  }

  function getOpeningScript(name) {
    return getOpeningScriptLines(name).join(" ");
  }

  function getTransitionPhrase(index, name, jobRole) {
    const safeName = (name || "Student").trim() || "Student";
    const role = (jobRole || "this role").trim() || "this role";
    const phrases = [
      `Okay, ${safeName}! Let's begin your ${role} interview.`,
      `Nice introduction, ${safeName}! Let's hear about your studies next.`,
      `That's wonderful to hear. Moving right along to question three.`,
      `I really appreciate your enthusiasm, ${safeName}! Let's keep going.`,
      `Great points! You're doing really well so far.`,
      `Honest self-reflection is such a great quality, ${safeName}. Halfway there!`,
      `Awesome — keep that momentum going! Let's look at problem solving.`,
      `Well explained, ${safeName}! Now let's talk about working with others.`,
      `Lovely example! Only two questions left — you've got this.`,
      `That's an inspiring goal, ${safeName}. You've reached our final question!`,
    ];
    return phrases[index] || `You're doing great, ${safeName}! Let's continue.`;
  }

  function getQuestionSpokenText(index, name, jobRole, questionObj) {
    const safeName = (name || "Student").trim() || "Student";
    const q = questionObj || PREPLANNED_QUESTIONS[index];
    if (!q) return "";

    const openers = [
      `Okay, ${safeName}, let's get started! Question number one.`,
      `Nice introduction, ${safeName}! Let's talk about your background next. Question number two.`,
      `That's wonderful to hear. Moving right along to question number three.`,
      `I really appreciate your enthusiasm, ${safeName}. Now for question number four.`,
      `Great points! You're doing really well so far. Question number five.`,
      `Honest self-reflection is a great quality, ${safeName}. Halfway done! Question number six.`,
      `Awesome, keep that momentum going! Question number seven.`,
      `Well explained, ${safeName}! Let's look at teamwork in question number eight.`,
      `Lovely example! Just two more to go. Question number nine.`,
      `That's an inspiring goal, ${safeName}. You've made it to our final question! Question number ten.`,
    ];

    const opener = openers[index] || `You're doing great, ${safeName}! Question number ${q.numberWord}.`;
    return `${opener} ${q.question}`;
  }

  function getClosingSpokenText(name) {
    const safeName = (name || "Student").trim() || "Student";
    return `Wonderful job, ${safeName}! You handled all ten questions with great effort. Give me just a moment while I put together your personalized feedback report.`;
  }

  return {
    PREPLANNED_QUESTIONS,
    CAREER_ROLES,
    getOpeningScriptLines,
    getOpeningScript,
    getTransitionPhrase,
    getQuestionSpokenText,
    getClosingSpokenText,
  };
})();
