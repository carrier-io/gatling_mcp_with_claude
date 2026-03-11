import re
import json
import sys

class ErrorLogHandler:
    def __init__(self, error_log_file_path):
        self.error_log_file_path = error_log_file_path

    def parse_and_group_errors(self):
        body_pattern = re.compile(r"content=(.*?)(?=\n=+)", re.DOTALL)
        error_pattern = re.compile(
            r".*?Request:\n(?P<request_name>.*?): KO (?P<error_message>.*?)\n"
            r".*?(?P<method>GET|POST|PUT|DELETE) (?P<url>https?://[^\s]+)\n"
            r"headers:\n(?P<request_headers>(?:\t.*?\n)*)"
            r".*?status:\n\t(?P<response_code>\d+).*?"
            r".*?body:\n(?P<response_body>.*?)<<<<<<<<<<<<<<<<<<<<<<<<<",
            re.DOTALL
        )
        sensitive_headers = [
            'authorization', 'proxy-authorization', 'x-api-key', 'x-auth-token', 'x-access-token',
            'set-cookie', 'cookie', 'password', 'x-password', 'x-session-token', 'x-csrf-token',
            'x-xsrf-token', 'x-refresh-token', 'x-secret', 'x-client-secret', 'x-client-key',
            'x-private-key', 'x-user-token', 'x-user-secret', 'x-otp', 'x-mfa', 'x-sso-token',
            'x-id-token', 'x-refresh-token', 'x-jwt', 'jwt', 'bearer'
        ]
        with open(self.error_log_file_path, 'r') as file:
            data = file.read()
        blocks = data.split('<<<<<<<<<<<<<<<<<<<<<<<<<')
        grouped_errors = {}
        for block in blocks:
            if not block.strip():
                continue
            match = error_pattern.search(block + '<<<<<<<<<<<<<<<<<<<<<<<<<')
            if match:
                error_data = match.groupdict()
                url_parts = error_data["url"].split("?")
                request_params = url_parts[1] if len(url_parts) > 1 else None
                request_headers = {}
                for line in error_data["request_headers"].strip().split("\n"):
                    if ":" in line:
                        k, v = line.split(":", 1)
                        k_lower = k.strip().lower()
                        v_lower = v.strip().lower()
                        if k_lower in sensitive_headers or any(s in v_lower for s in sensitive_headers):
                            request_headers[k.strip()] = '***'
                        else:
                            request_headers[k.strip()] = v.strip()
                request_body = ""
                body_match = body_pattern.search(block)
                if body_match:
                    request_body = body_match.group(1).strip().replace("\t", " ").replace("\\t", " ").replace("\n", " ").replace("\\n", " ")
                if len(request_body) > 5000:
                    request_body = request_body[:5000] + '...truncated'
                response_body = error_data["response_body"].strip().replace("\t", " ").replace("\\t", " ").replace("\n", " ").replace("\\n", " ") if error_data.get("response_body") else ""
                if len(response_body) > 5000:
                    response_body = response_body[:5000] + '...truncated'
                error_key = f'{error_data["request_name"]}_{error_data["method"]}_{error_data["response_code"]}'
                if error_key not in grouped_errors:
                    grouped_errors[error_key] = {
                        "error_key": error_key,
                        "request_name": error_data["request_name"],
                        "method": error_data["method"],
                        "response_code": error_data["response_code"],
                        "url": error_data["url"],
                        "error_message": error_data["error_message"],
                        "request_params": request_params,
                        "request_headers": request_headers,
                        "request_body": request_body,
                        "response_body": response_body,
                        "count": 1
                    }
                else:
                    grouped_errors[error_key]["count"] += 1
        return grouped_errors


if __name__ == '__main__':
    # Accept working directory as a command-line argument, default to /opt/gatling
    working_dir = sys.argv[1] if len(sys.argv) > 1 else "/opt/gatling"
    log_path = f"{working_dir}/target/gatling/simulation-errors.log"
    handler = ErrorLogHandler(log_path)
    grouped_errors = handler.parse_and_group_errors()
    print(json.dumps(grouped_errors, indent=2))
    with open(f"{working_dir}/errors.json", 'w') as f:
        json.dump(grouped_errors, f, indent=2)