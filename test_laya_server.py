import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).with_name("laya-server.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTest(unittest.TestCase):
    def test_translation_normalization_and_context_rejection(self):
        common = types.ModuleType("laya.common")
        common.render_options = lambda q: [k + ": " + v for k, v in q["crit"].items()]
        common.serialize_state = str

        class Tokenizer:
            mask_token = "[MASK]"
            def __call__(self, text, **kwargs):
                return {"input_ids": text.split()}

        class Agent:
            tok = Tokenizer()
            cfg = {"max_len": 128, "head_max_len": 48}
            def predict(self, state, questions):
                self.questions = questions
                self.state = state
                return {"answers": {"q": {"probabilities": {"a": .3333, "b": .6666}}}, "usage": {"input_tokens": 12}}

        agent = Agent()
        request = {"id": "q", "state": "evidence", "question": "Choose", "options": [{"id": "a", "description": "first"}, {"id": "b", "description": "second"}]}
        with patch.dict(sys.modules, {"laya.common": common}):
            result = bridge.score(agent, request)
            self.assertEqual(result["option_ids"], ["a", "b"])
            self.assertAlmostEqual(sum(result["probabilities"]), 1)
            self.assertEqual(agent.questions["q"]["criteria"], {"a": "Option a", "b": "Option b"})
            self.assertEqual(agent.state, {"policy": "Choose", "options": request["options"], "evidence": "evidence"})
            for field in ("state", "question"):
                with self.assertRaises(ValueError):
                    bridge.score(agent, {**request, field: "word " * 500})
            with self.assertRaises(ValueError):
                bridge.score(agent, {**request, "options": [request["options"][0]] * 2})
            with self.assertRaises(ValueError):
                bridge.score(agent, {**request, "options": [{"id": "a", "description": "word " * 500}, request["options"][1]]})


if __name__ == "__main__":
    unittest.main()
