FROM python:3.13-slim
RUN pip install --no-cache-dir PyMuPDF==1.28.2
WORKDIR /artifacts
COPY scripts/check-pdf.py /check-pdf.py
COPY scripts/check-format-pdf.py /check-format-pdf.py
COPY scripts/check-annotations-pdf.py /check-annotations-pdf.py
ENTRYPOINT ["python", "/check-pdf.py"]
