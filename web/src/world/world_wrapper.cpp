#include <cmath>
#include <cstdlib>
#include <vector>
#include "world/cheaptrick.h"
#include "world/d4c.h"
#include "world/dio.h"
#include "world/stonemask.h"
#include "world/synthesis.h"

extern "C" {

int world_dimensions(int x_length, int fs, double frame_period, int *frame_count, int *fft_size) {
  if (x_length < 2 || fs < 1 || !std::isfinite(frame_period) || frame_period <= 0 || frame_count == nullptr || fft_size == nullptr) return -1;
  DioOption dio_option;
  InitializeDioOption(&dio_option);
  *frame_count = GetSamplesForDIO(fs, x_length, frame_period);
  CheapTrickOption cheaptrick_option;
  InitializeCheapTrickOption(fs, &cheaptrick_option);
  *fft_size = GetFFTSizeForCheapTrick(fs, &cheaptrick_option);
  return *frame_count > 0 && *fft_size > 0 ? 0 : -2;
}

int world_analyze_f0(const double *x, int x_length, int fs, double frame_period, int frame_count, double *f0, double *times) {
  if (x == nullptr || f0 == nullptr || times == nullptr) return -1;
  int expected_frames = 0;
  int ignored_fft_size = 0;
  if (world_dimensions(x_length, fs, frame_period, &expected_frames, &ignored_fft_size) != 0) return -2;
  if (frame_count != expected_frames) return -3;
  DioOption dio_option;
  InitializeDioOption(&dio_option);
  dio_option.frame_period = frame_period;
  Dio(x, x_length, fs, &dio_option, times, f0);
  std::vector<double> refined_f0(frame_count);
  StoneMask(x, x_length, fs, times, f0, frame_count, refined_f0.data());
  for (int i = 0; i < frame_count; ++i) f0[i] = refined_f0[i];
  return 0;
}

int world_analyze(const double *x, int x_length, int fs, double frame_period, int frame_count, int fft_size, double *f0, double *times, double *spectrogram, double *aperiodicity) {
  if (x == nullptr || f0 == nullptr || times == nullptr || spectrogram == nullptr || aperiodicity == nullptr) return -1;
  int expected_frames = 0;
  int expected_fft = 0;
  if (world_dimensions(x_length, fs, frame_period, &expected_frames, &expected_fft) != 0) return -2;
  if (frame_count != expected_frames || fft_size != expected_fft) return -3;
  if (world_analyze_f0(x, x_length, fs, frame_period, frame_count, f0, times) != 0) return -4;
  CheapTrickOption cheaptrick_option;
  InitializeCheapTrickOption(fs, &cheaptrick_option);
  cheaptrick_option.fft_size = fft_size;
  cheaptrick_option.q1 = -0.15;
  const int bins = fft_size / 2 + 1;
  std::vector<double *> spectrum_rows(frame_count);
  std::vector<double *> aperiodicity_rows(frame_count);
  for (int i = 0; i < frame_count; ++i) {
    spectrum_rows[i] = spectrogram + static_cast<size_t>(i) * bins;
    aperiodicity_rows[i] = aperiodicity + static_cast<size_t>(i) * bins;
  }
  CheapTrick(x, x_length, fs, times, f0, frame_count, &cheaptrick_option, spectrum_rows.data());
  D4COption d4c_option;
  InitializeD4COption(&d4c_option);
  D4C(x, x_length, fs, times, f0, frame_count, fft_size, &d4c_option, aperiodicity_rows.data());
  return 0;
}

int world_synthesize(const double *f0, int frame_count, const double *spectrogram, const double *aperiodicity, int fft_size, double frame_period, int fs, int output_length, double *output) {
  if (f0 == nullptr || spectrogram == nullptr || aperiodicity == nullptr || output == nullptr || frame_count < 1 || fft_size < 2 || output_length < 1) return -1;
  const int bins = fft_size / 2 + 1;
  std::vector<const double *> spectrum_rows(frame_count);
  std::vector<const double *> aperiodicity_rows(frame_count);
  for (int i = 0; i < frame_count; ++i) {
    spectrum_rows[i] = spectrogram + static_cast<size_t>(i) * bins;
    aperiodicity_rows[i] = aperiodicity + static_cast<size_t>(i) * bins;
  }
  Synthesis(f0, frame_count, spectrum_rows.data(), aperiodicity_rows.data(), fft_size, frame_period, fs, output_length, output);
  return 0;
}

}
