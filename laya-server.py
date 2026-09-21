"""Local Laya bridge for jevRouter.apiUrl. Install laya separately."""
import argparse
import json
import math
from http.server import BaseHTTPRequestHandler, HTTPServer


def score(agent, request):
    from laya.common import render_options, serialize_state

    if not isinstance(request, dict) or not isinstance(request.get("id"), str) or not isinstance(request.get("question"), str) or "state" not in request:
        raise ValueError("Invalid request")
    options = request.get("options")
    if not isinstance(options, list) or not 2 <= len(options) <= 16:
        raise ValueError("Expected 2-16 options")
    if any(not isinstance(o, dict) or not isinstance(o.get("id"), str) or not isinstance(o.get("description"), str) for o in options):
        raise ValueError("Invalid options")
    keys = [o["id"] for o in options]
    if len(set(keys)) != len(keys):
        raise ValueError("Duplicate options")
    question = {"type": "choice", "instructions": request["question"], "criteria": {o["id"]: o["description"] for o in options}}
    internal = {"t": "choice", "ins": question["instructions"], "crit": question["criteria"]}
    # Mirror Laya's formatter limits, rejecting every kind of silent truncation.
    def length(text):
        return len(agent.tok(text.replace(agent.tok.mask_token, " "), add_special_tokens=False)["input_ids"])
    option_lengths = [length(" " + text) for text in render_options(internal)]
    head = length("choice question: " + question["instructions"])
    budget = agent.cfg.get("head_max_len", 192) - sum(n + 1 for n in option_lengths)
    total = head + sum(n + 1 for n in option_lengths) + length(serialize_state(request["state"])) + 4
    if max(option_lengths) > 48 or budget < 16 or head > budget or total > agent.cfg.get("max_len", 512):
        raise ValueError("Request exceeds Laya context or criteria limits; use shorter evidence and descriptions")
    result = agent.predict(request["state"], {request["id"]: question})
    distribution = result["answers"][request["id"]]["probabilities"]
    probabilities = [distribution[key] for key in keys]
    if any(not isinstance(p, (float, int)) or not math.isfinite(p) or not 0 <= p <= 1 for p in probabilities) or not 0 < sum(probabilities):
        raise ValueError("Invalid Laya probabilities")
    # Laya rounds probabilities to four decimals; restore a normalized distribution.
    total = sum(probabilities)
    return {"id": request["id"], "option_ids": keys, "probabilities": [p / total for p in probabilities], "input_tokens": result["usage"]["input_tokens"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", default="convaiinnovations/laya")
    args = parser.parse_args()
    import laya
    agent = laya.load(args.model)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path != "/score":
                self.send_error(404)
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 1_048_576:
                    raise ValueError("Invalid request size")
                request = json.loads(self.rfile.read(size))
                result = score(agent, request)
                status = 200
            except (ValueError, KeyError, TypeError):
                status, result = 422, {"error": "Invalid request or Laya context limit exceeded"}
            except Exception:
                status, result = 500, {"error": "Laya inference failed"}
            body = json.dumps(result).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass  # Never log conversation evidence or request paths.

    # Serial inference avoids concurrent model access; bind only to loopback.
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
