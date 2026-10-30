FROM python:3.13-slim
RUN pip install --no-cache-dir PyMuPDF==1.28.2
WORKDIR /artifacts
ENTRYPOINT ["python", "/check-pdf.py"]
