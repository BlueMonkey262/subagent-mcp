"""Strips request fields Codex sends that NVIDIA NIM's chat/completions
endpoint rejects (e.g. client_metadata), before litellm forwards them."""

from litellm.integrations.custom_logger import CustomLogger

UNSUPPORTED_FIELDS = ("client_metadata",)


class StripUnsupportedFields(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        for field in UNSUPPORTED_FIELDS:
            data.pop(field, None)
            extra_body = data.get("extra_body")
            if isinstance(extra_body, dict):
                extra_body.pop(field, None)
        return data


proxy_handler_instance = StripUnsupportedFields()
