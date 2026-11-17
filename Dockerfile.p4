FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    P4_OUTPUT_DIR=/tmp/p4-reports
WORKDIR /app
COPY monthly_close_agent/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY monthly_close_agent /app/monthly_close_agent
RUN useradd --system --uid 10001 p4 && mkdir -p /tmp/p4-reports && chown p4 /tmp/p4-reports
USER p4
EXPOSE 8080
CMD ["python", "-m", "monthly_close_agent.mcp_server"]
