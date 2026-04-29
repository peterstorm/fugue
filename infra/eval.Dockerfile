FROM python:3.12-slim
WORKDIR /eval
COPY apps/customer-summary/eval/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/customer-summary/eval/ .
COPY apps/customer-summary/fixtures/ /eval/fixtures/
CMD ["python", "run.py"]
