import { useEffect, useState } from "react";

const UNLOCK_EXPRESSION = "1234-5678";

type Token = { kind: "number" | "operator" | "left" | "right"; value: string };

function calculate(source: string): number {
  const input = source.replace(/\s/g, "");
  const tokens: Token[] = [];
  const re = /(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/]/g;
  let match: RegExpExecArray | null;
  let end = 0;
  while ((match = re.exec(input))) {
    if (match.index !== end) throw new Error("Invalid expression");
    const value = match[0];
    tokens.push({
      kind: /^\d|^\./.test(value) ? "number" : value === "(" ? "left" : value === ")" ? "right" : "operator",
      value,
    });
    end = re.lastIndex;
  }
  if (!tokens.length || end !== input.length) throw new Error("Invalid expression");

  let index = 0;
  const primary = (): number => {
    const token = tokens[index++];
    if (!token) throw new Error("Invalid expression");
    if (token.kind === "number") return Number(token.value);
    if (token.kind === "left") {
      const value = expression();
      if (tokens[index++]?.kind !== "right") throw new Error("Invalid expression");
      return value;
    }
    if (token.kind === "operator" && (token.value === "+" || token.value === "-")) {
      const value = primary();
      return token.value === "-" ? -value : value;
    }
    throw new Error("Invalid expression");
  };
  const term = (): number => {
    let value = primary();
    while (tokens[index]?.kind === "operator" && ["*", "/"].includes(tokens[index].value)) {
      const operator = tokens[index++].value;
      const next = primary();
      value = operator === "*" ? value * next : value / next;
    }
    return value;
  };
  const expression = (): number => {
    let value = term();
    while (tokens[index]?.kind === "operator" && ["+", "-"].includes(tokens[index].value)) {
      const operator = tokens[index++].value;
      const next = term();
      value = operator === "+" ? value + next : value - next;
    }
    return value;
  };

  const result = expression();
  if (index !== tokens.length || !Number.isFinite(result)) throw new Error("Invalid expression");
  return result;
}

const keys = [
  ["AC", "DEL", "(", ")"],
  ["7", "8", "9", "/"],
  ["4", "5", "6", "*"],
  ["1", "2", "3", "-"],
  ["0", ".", "=", "+"],
];

export default function CalculatorGate({ onUnlock }: { onUnlock: () => void }) {
  const [expression, setExpression] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const press = (key: string) => {
    if (key === "AC") {
      setExpression("");
      setResult(null);
      return;
    }
    if (key === "DEL") {
      setExpression((value) => value.slice(0, -1));
      setResult(null);
      return;
    }
    if (key === "=") {
      if (expression.replace(/\s/g, "") === UNLOCK_EXPRESSION) {
        setExpression("");
        setResult(null);
        onUnlock();
        return;
      }
      try {
        setResult(String(calculate(expression)));
      } catch {
        setResult("错误");
      }
      return;
    }
    setExpression((value) => value + key);
    setResult(null);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key;
      if (/^[0-9.+*\/()\-]$/.test(key)) {
        event.preventDefault();
        press(key);
      } else if (key === "Enter" || key === "=") {
        event.preventDefault();
        press("=");
      } else if (key === "Backspace") {
        event.preventDefault();
        press("DEL");
      } else if (key === "Escape") {
        event.preventDefault();
        press("AC");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expression]);

  return (
    <main data-calculator-gate className="fixed inset-0 z-[100] flex items-center justify-center bg-[#e9e9eb] text-[#171719]">
      <section className="flex h-full w-full max-w-[520px] flex-col px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(28px,env(safe-area-inset-top))] sm:h-[min(780px,94dvh)] sm:rounded-[32px] sm:shadow-2xl">
        <header className="flex h-12 items-center justify-center text-[15px] font-medium">计算器</header>
        <div className="flex min-h-0 flex-1 flex-col justify-end px-2 pb-6 text-right">
          <div className="min-h-7 break-all text-[20px] text-[#77777b]">{expression || " "}</div>
          <div className="mt-2 min-h-[58px] break-all text-[48px] font-light leading-tight tabular-nums" aria-live="polite">
            {result ?? (expression ? " " : "0")}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {keys.flat().map((key) => {
            const isOperator = ["/", "*", "-", "+", "="].includes(key);
            const isUtility = key === "AC" || key === "DEL" || key === "(" || key === ")";
            return (
              <button key={key} type="button" onClick={() => press(key)} aria-label={key === "=" ? "等于" : key}
                className={`aspect-square rounded-full text-[22px] font-medium tabular-nums transition active:scale-95 ${
                  isOperator ? "bg-[#ff9f0a] text-white" : isUtility ? "bg-[#d4d4d6] text-[#171719]" : "bg-[#f7f7f8] text-[#171719]"
                }`}>
                {key === "*" ? "×" : key === "/" ? "÷" : key === "DEL" ? "⌫" : key === "=" ? "=" : key}
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}
